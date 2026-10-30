import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { HistoryStore, ImportedItemEntry } from "../src/history.js";
import { activity, history, toolDetails } from "../src/transcript.js";
import { validEvent } from "../src/protocol.js";
import type { HistoryImportBatch } from "../src/generated/HistoryImportBatch.js";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import type { HistoryMessage } from "../src/generated/HistoryMessage.js";

async function fixture(directory: string) {
  const registry = createRegistry(), models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  return { session, registry, faux, store: new HistoryStore(session, join(directory, "assets")) };
}
function item(kind: string, data: HistoryItem["data"], role: HistoryItem["role"] = "tool", order = 0): HistoryItem {
  return { id: "native-" + kind, turn_id: "original-turn", kind, role, text: "", version: "original-version", order, timestamp_ms: 1, data, assets: [] };
}
function batch(items: HistoryItem[]): HistoryImportBatch {
  return { host_id: "fixture-host", thread: { id: "original-thread", title: "Retained native evidence", cwd: "/example", created_at: 1, updated_at: 2,
    forked_from_id: null, parent_thread_id: null, version: "thread-version", version_reliable: true, archived: true },
    items, next_cursor: null, complete: true, gaps: [] };
}
async function read(app: Awaited<ReturnType<typeof fixture>>, id: string): Promise<HistoryMessage[]> {
  const conversation = await app.store.conversation(id); assert.ok(conversation);
  const frames = await history(conversation, null, app.session);
  for (const frame of frames) assert.ok(validEvent({ version: 1, id: 1, event: frame }), "Actual projection must satisfy the Rust-owned wire schema");
  return frames.flatMap((frame) => frame.messages);
}

test("all nineteen native kinds and future originals project through canonical messages without reimporting retained entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-canonical-history-")); let app = await fixture(directory);
  const originals = [
    item("userMessage", { content: [{ type: "text", text: "Original request" }] }, "user"),
    item("hookPrompt", { fragments: [{ text: "Historical hook instructions stay inert" }] }),
    item("agentMessage", { text: "Original final", phase: "final_answer" }, "assistant"),
    item("functionCallOutput", { name: "inspect", output: "Verified output" }),
    item("plan", { text: "Original plan" }, "assistant"),
    item("reasoning", { summary: ["Exposed reasoning summary"], content: [] }, "thinking"),
    item("commandExecution", { command: "printf fixture", cwd: "/example", status: "declined", exitCode: null, durationMs: 1, aggregatedOutput: "Original command output" }),
    item("fileChange", { changes: [{ path: "example.rs", kind: { type: "update" }, diff: "Original diff" }], status: "completed" }),
    item("mcpToolCall", { server: "fixture", tool: "inspect", arguments: { exact: true }, status: "failed", error: { message: "Original error" } }),
    item("dynamicToolCall", { tool: "inspect", arguments: {}, status: "futureStatus", contentItems: [{ type: "inputText", text: "Original tool output" }] }),
    item("collabAgentToolCall", { tool: "interruptAgent", status: "interrupted", senderThreadId: "parent", receiverThreadIds: ["child"], agentsStates: { child: { status: "interrupted" } } }),
    item("subAgentActivity", { agentPath: "/root/review", agentThreadId: "child", kind: "completed" }),
    item("webSearch", { query: "synthetic schema", action: { type: "openPage", url: "https://example.com/schema" } }),
    item("imageView", { path: "/example/source.png" }),
    item("sleep", { durationMs: 1000 }),
    item("imageGeneration", { status: "completed", result: "SYNTHETIC_ENCODED_IMAGE_BYTES", inputImages: [] }),
    item("enteredReviewMode", { review: "Original review" }, "assistant"),
    item("exitedReviewMode", { review: "Verified review" }, "assistant"),
    item("contextCompaction", {}),
    item("futureNativeItem", { future: { evidence: "Unknown payload remains intact" } }),
  ].map((value, order) => ({ ...value, order }));
  try {
    const receipt = await app.store.import(batch(originals)), id = receipt.conversation.conversation_id;
    const conversation = await app.store.conversation(id); assert.ok(conversation);
    const retained = (await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
    const messages = await read(app, id);
    assert.equal(messages.length, originals.length, "Every actual native event needs a meaningful canonical row");
    const rows = new Map(retained.filter(ImportedItemEntry.is).map((entry) => [entry.data.item.kind, messages.find((message) => message.entry_id === entry.id.toString())]));
    assert.equal(rows.get("userMessage")?.role, "user"); assert.equal(rows.get("agentMessage")?.role, "final"); assert.equal(rows.get("reasoning")?.role, "thinking");
    assert.equal(rows.get("commandExecution")?.presentation?.type, "command"); assert.equal(rows.get("commandExecution")?.tool?.status, "declined");
    const changes = rows.get("fileChange")?.presentation; assert.equal(changes?.type, "file_changes");
    if (changes?.type === "file_changes") assert.equal(changes.changes[0]?.path, "example.rs");
    assert.equal(rows.get("fileChange")?.text, "Original diff");
    assert.equal(rows.get("commandExecution")?.text, "Original command output");
    assert.equal(rows.get("mcpToolCall")?.tool?.status, "failed"); assert.equal(rows.get("dynamicToolCall")?.tool?.status, "unknown");
    assert.equal(rows.get("collabAgentToolCall")?.tool?.status, "interrupted"); assert.equal(rows.get("subAgentActivity")?.presentation?.type, "agent_activity");
    const agent = rows.get("subAgentActivity")?.presentation;
    if (agent?.type === "agent_activity") assert.equal(agent.state, "completed");
    assert.equal(rows.get("webSearch")?.presentation?.type, "web_search");
    assert.equal(rows.get("imageView")?.presentation?.type, "media"); assert.equal(rows.get("imageGeneration")?.presentation?.type, "media");
    assert.doesNotMatch(rows.get("imageGeneration")?.text ?? "", /SYNTHETIC_ENCODED_IMAGE_BYTES/);
    assert.equal(rows.get("sleep")?.presentation?.type, "sleep"); assert.equal(rows.get("hookPrompt")?.presentation?.type, "hook_prompt");
    assert.doesNotMatch(rows.get("hookPrompt")?.text ?? "", /instructions stay inert/);
    assert.equal(rows.get("contextCompaction")?.presentation?.type, "compaction"); assert.equal(rows.get("futureNativeItem")?.presentation?.type, "unknown");
    assert.equal(rows.get("plan")?.presentation?.type, "plan"); assert.equal(rows.get("enteredReviewMode")?.presentation?.type, "review");
    assert.equal(rows.get("exitedReviewMode")?.presentation?.type, "review"); assert.equal(rows.get("functionCallOutput")?.tool?.name, "inspect");
    assert.ok(messages.every((message) => message.text.trim().length > 0 || message.presentation !== undefined));
    assert.deepEqual((await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items, retained);
    assert.deepEqual((await conversation.context(BACKGROUND_CONTEXT)).messages, []);
    assert.equal(app.faux.state.callCount, 0);
    await app.session.close(BACKGROUND_CONTEXT); app = await fixture(directory);
    assert.deepEqual(await read(app, id), messages);
    assert.deepEqual((await (await app.store.conversation(id))?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT))?.items, retained);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("verified cold originals supply canonical details and deleted evidence remains an explicit presentation gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-cold-presentation-")); const app = await fixture(directory);
  try {
    await mkdir(join(directory, "assets"));
    const original = { type: "fileChange", id: "native-fileChange", changes: [{ path: "restored.rs", kind: { type: "update" }, diff: "Original native diff\n".repeat(10_000) }], status: "completed" };
    const bytes = Buffer.from(JSON.stringify(original)), hash = createHash("sha256").update(bytes).digest("hex"), path = join(directory, "assets", hash);
    await writeFile(path, bytes, { mode: 0o600 });
    const saved = item("fileChange", null); saved.assets = [{ path, item_id: saved.id, version: saved.version, kind: "cold_evidence", media_type: "application/json", sha256: hash, size: bytes.length }];
    const imported = await app.store.import(batch([saved])), id = imported.conversation.conversation_id;
    const conversation = await app.store.conversation(id); assert.ok(conversation);
    const before = (await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
    let rows = await read(app, id); assert.equal(rows[0]?.presentation?.type, "file_changes"); assert.match(rows[0]?.text ?? "", /Original native diff/);
    assert.ok(rows[0]?.tool);
    const details = await toolDetails(conversation, rows[0].entry_id, rows[0].tool.call_id, app.session);
    assert.equal(details.type, "available");
    if (details.type === "available") { assert.equal(details.status, "finished"); assert.equal(details.input.type, "text"); if (details.input.type === "text") assert.equal(details.input.truncated, true); }
    await rm(path); rows = await read(app, id);
    assert.equal(rows[0]?.presentation?.type, "unavailable"); assert.equal(rows[0]?.text, "");
    await writeFile(path, bytes, { mode: 0o600 }); rows = await read(app, id); assert.equal(rows[0]?.presentation?.type, "file_changes");
    assert.deepEqual((await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items, before);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("actual live Pi command activity and retained Codex commands use the same canonical message and renderer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-live-history-parity-")), app = await fixture(directory);
  let stop = async () => {}, release = () => {}, entered = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const tools = defineExtension({ name: "canonical-exec-fixture", tools: [defineTool({ name: "exec", description: "Synthetic held command",
      parameters: Type.Object({ program: Type.String(), args: Type.Array(Type.String()), cwd: Type.String() }),
      async execute() { entered(); await gate; return { output: [{ type: "text", text: "Original output" }] }; } })] });
    app.registry.install(tools);
    const root = await app.session.root(BACKGROUND_CONTEXT); await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools] }, BACKGROUND_CONTEXT);
    const call = fauxToolCall("exec", { program: "printf", args: ["fixture"], cwd: "/example" });
    app.faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("Verified final")]);
    const live: HistoryMessage[] = []; stop = await activity(app.session, root, () => {}, (message) => live.push(message));
    const turn = await root.submit({ type: "input", content: "Run the synthetic check" }, BACKGROUND_CONTEXT); await started;
    const native = (await history(root, null, app.session)).flatMap((frame) => frame.messages).find((message) => message.tool?.call_id === call.id); assert.ok(native);
    const imported = await app.store.import(batch([item("commandExecution", { command: "printf fixture", cwd: "/example", status: "inProgress", exitCode: null, durationMs: null })]));
    const historic = (await read(app, imported.conversation.conversation_id))[0]; assert.ok(historic);
    assert.equal(native.presentation?.type, "command"); assert.equal(historic.presentation?.type, native.presentation?.type);
    assert.deepEqual(historic.presentation, native.presentation, "Both adapters normalize to the identical canonical structure");
    assert.equal(historic.tool?.status, native.tool?.status); assert.equal(historic.tool?.name, native.tool?.name);
    assert.equal(historic.text, native.text, "Both sources must use the common renderer rather than source-specific labels");
    release(); assert.equal((await turn.wait(BACKGROUND_CONTEXT)).status, "done"); await stop();
    assert.ok(live.some((message) => message.tool?.call_id === call.id && message.presentation?.type === "command" && message.text === native.text));
    assert.ok((await history(root, null, app.session)).flatMap((frame) => frame.messages).some((message) => message.tool?.call_id === call.id && message.tool.status === "finished"));
    assert.equal(app.faux.state.callCount, 2, "Import, history and live observation must not generate another turn");
  } finally { release(); await stop(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("distinct retained tool versions keep separate canonical identities and inspect their own originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-evidence-tool-identity-")); let app = await fixture(directory);
  try {
    const first = item("commandExecution", { command: "printf first", status: "completed", aggregatedOutput: "first output" });
    const second = { ...first, turn_id: "another-original-turn", version: "second-evidence-version", order: 1,
      data: { command: "printf second", status: "failed", aggregatedOutput: "second output" } };
    const saved = await app.store.import(batch([first, second])), id = saved.conversation.conversation_id;
    const conversation = await app.store.conversation(id); assert.ok(conversation);
    const rows = await read(app, id); assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.tool?.call_id)).size, 2);
    for (const [index, row] of rows.entries()) {
      assert.ok(row.tool);
      const details = await toolDetails(conversation, row.entry_id, row.tool.call_id, app.session);
      assert.equal(details.type, "available");
      if (details.type === "available") assert.deepEqual(details.input, { type: "text", text: "printf " + (index === 0 ? "first" : "second"), truncated: false });
    }
    await app.session.close(BACKGROUND_CONTEXT); app = await fixture(directory);
    assert.deepEqual(await read(app, id), rows);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
