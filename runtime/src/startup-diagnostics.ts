import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

type Stage = "storage_open" | "harness_recovery" | "application_recovery" | "environment_configure" | "node_registration";
type Cause = { kind: "sqlite" | "os"; code: number } | { kind: "error" | "unknown" };
type Record = { version: 1; time_ms: number; stage: Stage } & (
  { kind: "begin" } | { kind: "ready"; duration_ms: number } |
  { kind: "failed"; duration_ms: number; causes: Cause[]; truncated: boolean });
const MAX_BYTES = 64 * 1024;
const MAX_CAUSES = 4;

function object(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object";
}
function code(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
}
function causes(error: unknown): { causes: Cause[]; truncated: boolean } {
  const result: Cause[] = [], seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && result.length < MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    if (object(current) && current.code === "ERR_SQLITE_ERROR" && code(current.errcode)) result.push({ kind: "sqlite", code: current.errcode });
    else if (object(current) && code(current.errno)) result.push({ kind: "os", code: current.errno });
    else result.push({ kind: current instanceof Error ? "error" : "unknown" });
    current = object(current) ? current.cause : undefined;
  }
  return { causes: result, truncated: current !== undefined };
}

/** Startup has no transport yet. Keep only fixed stages and native numeric
 * failure codes in its private bounded file; diagnostics never own recovery. */
export class StartupDiagnostics {
  private writing = Promise.resolve();
  constructor(private readonly state: string) {}
  private record(record: Record): Promise<void> {
    const writing = this.writing.then(async () => {
      const directory = join(this.state, "diagnostics");
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      const file = await open(join(directory, "startup.jsonl"), "a", 0o600);
      try {
        await file.chmod(0o600);
        const line = JSON.stringify(record) + "\n";
        if ((await file.stat()).size + Buffer.byteLength(line) > MAX_BYTES) await file.truncate(0);
        await file.writeFile(line);
      } finally { await file.close(); }
    }).catch(() => {});
    return this.writing = writing;
  }
  async run<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    await this.record({ version: 1, time_ms: Date.now(), stage, kind: "begin" });
    try {
      const result = await action();
      await this.record({ version: 1, time_ms: Date.now(), stage, kind: "ready", duration_ms: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      // Even an unusual thrown object's getters must not replace its failure.
      try { await this.record({ version: 1, time_ms: Date.now(), stage, kind: "failed",
        duration_ms: Math.round(performance.now() - started), ...causes(error) }); } catch {}
      throw error;
    }
  }
}
