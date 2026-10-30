import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, UsageDoc } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { DiagnosticsTelemetry } from "../src/telemetry.js";
import { conversationUsage } from "../src/usage.js";
import { validEvent } from "../src/protocol.js";
import { history } from "../src/transcript.js";
import { publishMainNotice } from "../src/tasks.js";

const toolUsage: Usage = { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cacheWrite1h: 2, reasoning: 1, totalTokens: 18,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } };
async function open(directory: string) {
  const models = createModels(), first = fauxProvider({ provider: "openai", models: [{ id: "fixture", cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 3 } }], tokensPerSecond: 1_000_000 }),
    second = fauxProvider({ provider: "anthropic", models: [{ id: "unpriced" }], tokensPerSecond: 1_000_000 });
  models.setProvider(first.provider); models.setProvider(second.provider);
  const registry = createRegistry();
  const tools = defineExtension({ name: "fixture", tools: [defineTool({ name: "metered", description: "Synthetic metered tool", parameters: Type.Object({}),
    async execute() { return { output: [{ type: "text", text: "Private tool result" }], usage: toolUsage }; } })] });
  registry.install(tools);
  const telemetry = await DiagnosticsTelemetry.open(directory);
  const storage = await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite")));
  const session = await Harness.open(storage, { models, registry, identity: { attribution: null }, telemetry: telemetry.context }, BACKGROUND_CONTEXT);
  const root = await session.root(BACKGROUND_CONTEXT);
  return { session, root, first, second, telemetry, tools, storage,
    usage: () => conversationUsage(session, root.id.toString(), { available: true, dropped_spans: 0, dropped_measurements: 0 }),
    async close() { await session.close(BACKGROUND_CONTEXT); await telemetry.close(); } };
}

test("native model/tool usage survives reopen and history reads without double counting children or cache subsets", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-native-usage-")); let app = await open(directory);
  try {
    assert.equal((await app.usage()).recorded, false);
    await app.root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools] }, BACKGROUND_CONTEXT);
    app.first.setResponses([{ ...fauxAssistantMessage(fauxToolCall("metered", {}, { id: "metered-call" }), { stopReason: "toolUse" }), usage: toolUsage },
      { ...fauxAssistantMessage("Finished synthetic work"), usage: toolUsage }]);
    assert.equal((await (await app.root.submit({ type: "input", content: "Synthetic prompt" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    const native = await app.session.snapshot(UsageDoc, app.root.id, BACKGROUND_CONTEXT), usage = await app.usage();
    assert.ok(native?.models["openai/fixture"]); assert.equal(usage.recorded, true);
    assert.deepEqual(usage.models[0]?.tokens, { input: native.models["openai/fixture"].input, output: native.models["openai/fixture"].output,
      cache_read: native.models["openai/fixture"].cacheRead, cache_write: native.models["openai/fixture"].cacheWrite,
      cache_write_1h: native.models["openai/fixture"].cacheWrite1h ?? null, reasoning: native.models["openai/fixture"].reasoning ?? null,
      total: native.models["openai/fixture"].totalTokens });
    assert.equal(usage.models[0]?.cost.type, "unavailable", "The faux provider reports zero prices even when its catalog has rates");
    assert.deepEqual(usage.tools[0]?.cost, { type: "api_estimate", input_usd: 0.01, output_usd: 0.02, cache_read_usd: 0.03,
      cache_write_usd: 0.04, total_usd: 0.1 });
    assert.deepEqual(usage.tools[0]?.tokens, { input: 3, output: 4, cache_read: 5, cache_write: 6, cache_write_1h: 2, reasoning: 1, total: 18 });
    assert.equal(usage.recent_requests.length, 2); assert.ok(usage.recent_requests.every((request) => request.duration_ms === null), "The faux provider omits native durations; unknown timing must remain unavailable");
    assert.ok(validEvent({ version: 1, id: 1, event: { type: "conversation_usage", usage } }));
    const child = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await child.configure({ model: { provider: "anthropic", modelId: "unpriced" } }, BACKGROUND_CONTEXT);
    app.second.setResponses([fauxAssistantMessage("A separate conversation")]);
    await (await child.submit({ type: "input", content: "Independent work" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const unpriced = await conversationUsage(app.session, child.id.toString(), usage.telemetry);
    assert.equal(unpriced.models[0]?.name, "anthropic/unpriced"); assert.deepEqual(unpriced.models[0]?.cost, { type: "unavailable" });
    const final = (await child.entries({ order: "descending" }, 5, undefined, BACKGROUND_CONTEXT)).items.find(AssistantEntry.is); assert.ok(final);
    await publishMainNotice(app.session, child, final, null, [], { key: "synthetic", text: "Curated child update", events: [] });
    assert.deepEqual(await app.usage(), usage, "A notice copies child context, never a new root model request or extra spend");
    await history(app.root, null, app.session); assert.deepEqual(await app.usage(), usage);
    await app.close(); app = await open(directory);
    assert.deepEqual(await app.usage(), usage, "Native ledger and durations are durable; reopening must not re-meter retained entries");
    assert.equal(app.first.state.callCount + app.second.state.callCount, 0);
    const scans: number[] = [], original = app.storage.scanEntries.bind(app.storage);
    app.storage.scanEntries = (...args) => { scans.push(args[1]); return original(...args); };
    await app.usage(); assert.deepEqual(scans, [20], "Status must read one ledger and one bounded recent page");
    await assert.rejects(conversationUsage(app.session, "01", usage.telemetry), /existing native/);
    await assert.rejects(conversationUsage(app.session, "99999999", usage.telemetry), /unavailable/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native HTTP provider accounting exposes cache/reasoning and SDK cost estimates through SQLite reopen", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-native-http-usage-")); let requests = 0;
  const server = createServer((request, response) => {
    request.resume(); requests++;
    const item = { id: "synthetic-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic reply", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "synthetic-response", object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Synthetic reply" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "synthetic-response", object: "response", status: "completed", output: [item],
        usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } } } },
    ]) response.write("data: " + JSON.stringify(event) + "\n\n");
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const native = openaiProvider(), model = native.getModels()[0]; assert.ok(model);
  const models = createModels(); models.setProvider({ ...native,
    getModels: () => [{ ...model, baseUrl: `http://127.0.0.1:${address.port}/v1`, cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 3 } }],
    auth: { apiKey: { name: "Synthetic credential", resolve: async () => ({ auth: { apiKey: "sk-synthetic" } }) } } });
  const diagnostics = await DiagnosticsTelemetry.open(directory);
  let session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null }, telemetry: diagnostics.context,
      settings: { stream: { transport: "sse", maxRetries: 0 }, compaction: { enabled: false }, retry: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: model.id } }, BACKGROUND_CONTEXT);
    await (await root.submit({ type: "input", content: "A local synthetic request" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const telemetry = await diagnostics.status(); assert.equal(telemetry.available, true);
    const usage = await conversationUsage(session, root.id.toString(), telemetry);
    assert.deepEqual(usage.models[0]?.tokens, { input: 3, output: 7, cache_read: 2, cache_write: 0, cache_write_1h: null, reasoning: 3, total: 12 });
    const cost = usage.models[0]?.cost; assert.ok(cost?.type === "api_estimate"); assert.ok(cost.total_usd > 0);
    assert.ok(usage.recent_requests[0]?.duration_ms !== null && (usage.recent_requests[0]?.duration_ms ?? -1) >= 0);
    const ledger = await session.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT);
    assert.equal(cost.total_usd, ledger?.models[`openai/${model.id}`]?.cost.total);
    await session.close(BACKGROUND_CONTEXT);
    // Closing flushes the current ten-second metric interval without sleeping.
    await diagnostics.close();
    const database = await openNodeSqliteDatabase(join(directory, "diagnostics", "telemetry.sqlite"));
    try {
      const metrics = await database.all<{ name: string; unit: string; attributes: string; count: number; sum: number }>("SELECT name, unit, attributes, count, sum FROM telemetry_metrics");
      for (const name of ["pi.ai.request.duration", "pi.ai.first_chunk.duration"]) {
        const measured = metrics.find((metric) => metric.name === name);
        assert.ok(measured); assert.equal(measured.unit, "ms"); assert.equal(measured.count, 1); assert.ok(measured.sum >= 0);
      }
      const priced = metrics.find((metric) => metric.name === "pi.ai.cost");
      assert.ok(priced); assert.equal(priced.unit, "USD"); assert.equal(priced.sum, cost.total_usd);
      const tokens = metrics.filter((metric) => metric.name === "pi.ai.tokens");
      assert.equal(tokens.reduce((sum, metric) => sum + metric.sum, 0), 12);
      assert.ok(tokens.some((metric) => metric.sum === 2 && metric.attributes.includes('"kind":"cache_read"')));
      assert.equal(JSON.stringify(metrics).includes("synthetic-response"), false);
    } finally { await database.close(); }
    session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
      { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
    assert.deepEqual(await conversationUsage(session, root.id.toString(), telemetry), usage); assert.equal(requests, 1);
  } finally { await session.close(BACKGROUND_CONTEXT); await diagnostics.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test("native private telemetry retains timings and correlation but never prompt/tool/error payloads", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-private-telemetry-")); const app = await open(directory);
  try {
    const secret = "synthetic-private-payload-must-not-be-logged";
    await app.root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    app.first.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: secret, responseId: secret })]);
    await (await app.root.submit({ type: "input", content: secret }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await assert.rejects(app.telemetry.context.startSpan({ name: "pi.ai.request", attributes: { model: "fixture", prompt: secret } }, async (span) => {
      span.setAttributes({ body: secret, "response.id": secret }); span.addEvent("private", { args: secret });
      throw new Error(secret);
    }), /synthetic-private/);
    assert.equal((await app.telemetry.status()).available, true);
    const database = await openNodeSqliteDatabase(join(directory, "diagnostics", "telemetry.sqlite"));
    try {
      const spans = await database.all<{ name: string; attributes: string; events: string; status: string; started_ms: number; ended_ms: number; trace_id: string }>("SELECT * FROM telemetry_spans");
      assert.ok(spans.some((span) => span.name === "pi.ai.request")); assert.ok(spans.some((span) => span.name === "pi.durable.phase"));
      assert.ok(spans.some((span) => span.attributes.includes('"conversation.id":1')));
      assert.ok(spans.every((span) => span.ended_ms >= span.started_ms));
      assert.equal(JSON.stringify(spans).includes(secret), false);
      assert.equal((await stat(join(directory, "diagnostics"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, "diagnostics", "telemetry.sqlite"))).mode & 0o777, 0o600);
    } finally { await database.close(); }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unavailable diagnostics never own chat or native usage", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-telemetry-unavailable-"));
  await writeFile(join(directory, "diagnostics"), "Fixture prevents opening diagnostics");
  const app = await open(directory);
  try {
    assert.equal((await app.telemetry.status()).available, false);
    await app.root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    app.first.setResponses([fauxAssistantMessage("Still available")]);
    assert.equal((await (await app.root.submit({ type: "input", content: "Continue" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal((await app.usage()).recorded, true);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native recorder bounds its pending queue, reports dropped spans and drains on idempotent close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-telemetry-bound-")); const telemetry = await DiagnosticsTelemetry.open(directory);
  try {
    for (let index = 0; index < 2100; index++) await telemetry.context.startSpan({ name: "pi.ai.request", attributes: { model: "fixture", provider: "synthetic" } }, () => {});
    const status = await telemetry.status(); assert.equal(status.available, true); assert.equal(status.dropped_spans, 52);
    await Promise.all([telemetry.close(), telemetry.close()]);
    const database = await openNodeSqliteDatabase(join(directory, "diagnostics", "telemetry.sqlite"));
    try { assert.equal((await database.get<{ count: number }>("SELECT count(*) count FROM telemetry_spans"))?.count, 2048); }
    finally { await database.close(); }
  } finally { await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the real runtime returns durable usage without authentication, inference or transcript bodies", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-usage-wire-")); const app = await open(directory);
  try {
    await app.root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    app.first.setResponses([fauxAssistantMessage("Private synthetic result")]);
    await (await app.root.submit({ type: "input", content: "Private synthetic prompt" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const expected = await app.usage(); await app.close();
    const bridge = process.env.AGENT_TEST_USAGE_BRIDGE ?? fileURLToPath(new URL("../src/bridge.js", import.meta.url));
    const child = spawn(process.execPath, ["--no-warnings", bridge, directory], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ version: 1, id: 1, command: { type: "conversation_usage", conversation_id: "1" } }) + "\n");
    assert.equal(await closed, 0, stderr);
    const frames = stdout.trim().split("\n").map((line) => { const value: unknown = JSON.parse(line); assert.ok(validEvent(value)); return value; });
    const result = frames.find((frame) => frame.event.type === "conversation_usage")?.event;
    assert.ok(result?.type === "conversation_usage", "The native runtime must expose its persisted conversation ledger");
    assert.deepEqual(result.usage.models, expected.models); assert.deepEqual(result.usage.tools, expected.tools);
    assert.deepEqual(result.usage.recent_requests, expected.recent_requests); assert.equal(frames.at(-1)?.event.type, "done");
    assert.equal(stdout.includes("Private synthetic"), false);
    assert.ok(!(await readFile(join(directory, "diagnostics", "telemetry.sqlite"))).includes(Buffer.from("Private synthetic")));
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
