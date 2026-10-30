import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { createSqliteTelemetry, type SqliteTelemetry } from "@earendil-works/chord/telemetry-sqlite";
import { DURABLE_TELEMETRY_SCHEMA } from "@earendil-works/pi-durable";
import { NOOP_TELEMETRY_CONTEXT, type SpanAttributes, type TelemetryContext, type TelemetryMetrics,
  type TelemetrySchemaDefinition, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { TelemetryStatus } from "./generated/TelemetryStatus.js";

const schema: TelemetrySchemaDefinition = DURABLE_TELEMETRY_SCHEMA;
const requestAttributes = ["provider", "model", "api", "reasoning", "stop", "usage.input", "usage.output", "usage.cache_read", "usage.cache_write", "cost.total"];
const aiMetrics: Readonly<Record<string, readonly string[]>> = {
  "pi.ai.request.duration": ["provider", "model", "stop"], "pi.ai.first_chunk.duration": ["provider", "model"],
  "pi.ai.tokens": ["provider", "model", "kind"], "pi.ai.cost": ["provider", "model"],
};
function attributes(value: SpanAttributes | undefined, allowed: readonly string[]): SpanAttributes {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([name, item]) => allowed.includes(name) &&
    ((typeof item === "number" && Number.isFinite(item)) || typeof item === "boolean" ||
      (typeof item === "string" && item.length <= 256 && !/[\x00-\x1f\x7f]/u.test(item)))));
}

/** Keep native timing/usage/IDs, never content, arbitrary attributes, provider
 * response IDs or native error messages (which may contain a tool/provider body).
 * Wrapping propagation preserves Pi's persisted trace ownership across recovery. */
function privateContext(recorder: SqliteTelemetry): TelemetryContext {
  const originals = new WeakMap<TelemetryContext, TelemetryContext>();
  const metricKeys = (name: string) => aiMetrics[name] ?? Object.keys(schema.metrics?.[name]?.attributes ?? {});
  const metrics: TelemetryMetrics = {
    counter(name, options) {
      const target = recorder.metrics.counter(name, options);
      return { add(value, attrs) { if ((aiMetrics[name] !== undefined || schema.metrics?.[name] !== undefined) && Number.isFinite(value)) target.add(value, attributes(attrs, metricKeys(name))); } };
    },
    upDownCounter(name, options) {
      const target = recorder.metrics.upDownCounter(name, options);
      return { add(value, attrs) { if (schema.metrics?.[name] !== undefined && Number.isFinite(value)) target.add(value, attributes(attrs, metricKeys(name))); } };
    },
    histogram(name, options) {
      const target = recorder.metrics.histogram(name, options);
      return { record(value, attrs) { if ((aiMetrics[name] !== undefined || schema.metrics?.[name] !== undefined) && Number.isFinite(value)) target.record(value, attributes(attrs, metricKeys(name))); } };
    },
  };
  const wrap = (native: TelemetryContext): TelemetryContext => {
    const context: TelemetryContext = { metrics,
      propagation: { inject: (owner) => recorder.propagation.inject(originals.get(owner) ?? owner),
        extract: (carrier) => wrap(recorder.propagation.extract(carrier)) },
      async startSpan(options, callback) {
        const definition = schema.spans[options.name];
        const ai = options.name === "pi.ai.request" || options.name === "pi.ai.poll";
        if (definition === undefined && !ai) return NOOP_TELEMETRY_CONTEXT.startSpan({ name: "ignored" }, callback);
        const allowed = ai ? requestAttributes : [...Object.keys(definition?.startAttributes ?? {}), ...Object.keys(definition?.endAttributes ?? {})];
        return native.startSpan({ name: options.name, attributes: attributes(options.attributes, allowed),
          links: (options.links ?? []).map((link) => ({ context: originals.get(link.context) ?? link.context })) }, async (span) => {
          const safe: TelemetrySpan = { ...wrap(span), addLink: (link) => span.addLink({ context: originals.get(link.context) ?? link.context }),
            setStatus: (status) => span.setStatus({ status: status.status }),
            setAttributes: (attrs) => span.setAttributes(attributes(attrs, allowed)),
            addEvent(name, attrs) {
              const event = definition?.events?.[name];
              if (event !== undefined) span.addEvent(name, attributes(attrs, Object.keys(event.attributes)));
              else if (ai && name === "pi.ai.first_chunk") span.addEvent(name);
              else if (ai && name === "pi.ai.block") span.addEvent(name, attributes(attrs, ["type", "index", "chars", "tool"]));
            },
          };
          originals.set(safe, span);
          try { return await callback(safe); }
          catch (error) { span.setStatus({ status: "error" }); throw error; }
        });
      },
    };
    originals.set(context, native); return context;
  };
  return wrap(recorder);
}

/** The pinned native recorder owns bounded buffering, one-second flushes and
 * seven-day retention. Its private database and failures never own chat state. */
export class DiagnosticsTelemetry {
  readonly context: TelemetryContext;
  private failed: boolean;
  private closing: Promise<void> | undefined;
  private constructor(private readonly database?: SqliteDatabase, private readonly recorder?: SqliteTelemetry) {
    this.context = recorder === undefined ? NOOP_TELEMETRY_CONTEXT : privateContext(recorder);
    this.failed = recorder === undefined;
  }
  static async open(state: string): Promise<DiagnosticsTelemetry> {
    let database: SqliteDatabase | undefined;
    try {
      const directory = join(state, "diagnostics");
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      const path = join(directory, "telemetry.sqlite"); database = await openNodeSqliteDatabase(path); await chmod(path, 0o600);
      return new DiagnosticsTelemetry(database, await createSqliteTelemetry(database, { maxQueuedSpans: 2048 }));
    } catch { await database?.close().catch(() => {}); return new DiagnosticsTelemetry(); }
  }
  async status(): Promise<TelemetryStatus> {
    try { await this.recorder?.flush(); } catch { this.failed = true; }
    return { available: !this.failed, dropped_spans: this.recorder?.droppedSpans ?? 0,
      dropped_measurements: this.recorder?.droppedMeasurements ?? 0 };
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    try { await this.recorder?.close(); } catch { this.failed = true; }
    finally { await this.database?.close().catch(() => { this.failed = true; }); }
  }
}
