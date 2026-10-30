import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { codexMessage } from "../src/imported-history.js";
import { renderMessage } from "../src/message-presentation.js";
import { ConversationModels } from "../src/models.js";
import { validEvent } from "../src/protocol.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { activity, history, toolDetails } from "../src/transcript.js";
import type { HistoryMessage } from "../src/generated/HistoryMessage.js";
import type { HostResult } from "../src/generated/HostResult.js";
import { fixtureModel } from "./model.js";

async function fixture(directory: string) {
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)), executions = new Executions(), tools = createAppTools(tasks, executions);
  registry.install(tools.host); registry.install(tools.worker);
  return { session, registry, faux, tasks, executions, tools };
}

test("real application exec producer keeps typed command/output/status through live observation and SQLite reopen", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-live-command-")); let app = await fixture(directory);
  let release = () => {}, entered = () => {}, unbind = () => {}, stop = async () => {};
  const held = new Promise<HostResult>((resolve) => { release = () => resolve({ type: "process", exit_code: 7, stdout: "Actual stdout", stderr: "Actual stderr", truncated: false }); });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    unbind = app.executions.bind(root.id.toString(), { cwd: "/example", hosts: [], call: async (command) => {
      assert.equal(command.type, "exec");
      if (command.type === "exec") assert.deepEqual(command.args, ["hello world", "it's literal"]);
      entered(); return held;
    } });
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.host] }, BACKGROUND_CONTEXT);
    const call = fauxToolCall("exec", { program: "printf", args: ["hello world", "it's literal"] });
    app.faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("Checked the actual exit")]);
    const live: HistoryMessage[] = []; stop = await activity(app.session, root, () => {}, (message) => live.push(message));
    const turn = await root.submit({ type: "input", content: "Run the check" }, BACKGROUND_CONTEXT); await started;
    const starting = live.find((message) => message.tool?.call_id === call.id); assert.ok(starting);
    assert.deepEqual(starting.presentation, { type: "command", command: "printf 'hello world' 'it'\\''s literal'", exit_code: null, duration_ms: null });
    assert.equal(starting.text, ""); assert.equal(starting.tool?.status, "running");
    for (let index = 0; index < 25; index += 1) await root.commit((tx) => tx.appendEntry(root.id,
      { kind: "fixture.page-boundary", data: { index } }), BACKGROUND_CONTEXT);
    release(); assert.equal((await turn.wait(BACKGROUND_CONTEXT)).status, "done"); await stop(); stop = async () => {};
    const finished = live.find((message) => message.tool?.call_id === call.id && message.tool.status === "failed"); assert.ok(finished);
    assert.equal(finished.text, "Actual stdout\nActual stderr");
    assert.equal(finished.presentation?.type, "command");
    if (finished.presentation?.type !== "command") assert.fail("Actual exec result needs command metadata");
    assert.equal(finished.presentation.command, "printf 'hello world' 'it'\\''s literal'");
    assert.equal(finished.presentation.exit_code, 7); assert.ok(finished.presentation.duration_ms !== null);
    const before = (await history(root, null, app.session)).flatMap((frame) => frame.messages);
    assert.deepEqual(before.filter((message) => message.tool?.call_id === call.id), [finished], "A recent result page is self-contained when the call lies outside its bounded window");
    const resultEntry = (await root.entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT)).items.find((entry) => entry.id.toString() === finished.entry_id);
    assert.ok(resultEntry);
    const native = resultEntry.model?.find((message) => message.role === "toolResult"); assert.ok(native);
    assert.deepEqual(native.details, { role: "tool", text: finished.text, presentation: { ...starting.presentation, exit_code: 7 } },
      "Native Pi persists shared UI body and metadata separately from tool output");
    assert.deepEqual(native.content, [{ type: "text", text: JSON.stringify({ type: "process", exit_code: 7, stdout: "Actual stdout", stderr: "Actual stderr", truncated: false }) }]);
    for (const message of live) assert.ok(validEvent({ version: 1, id: 1, event: { type: "message", message } }));

    const store = new HistoryStore(app.session);
    const original = { type: "commandExecution", command: finished.presentation.command, status: "failed", exitCode: 7,
      durationMs: finished.presentation.duration_ms, aggregatedOutput: finished.text };
    const item = { id: "native-command", turn_id: "original-turn", kind: "commandExecution", role: "tool", text: "Legacy indexed excerpt",
      version: "v1", order: 0, timestamp_ms: null, data: original, assets: [] } satisfies Parameters<HistoryStore["import"]>[0]["items"][number];
    const imported = await store.import({ host_id: "source", thread: { id: "original-thread", title: "Command evidence", cwd: "/example", created_at: 1, updated_at: 2,
      forked_from_id: null, parent_thread_id: null, version: "v1", version_reliable: true, archived: false }, items: [item], next_cursor: null, complete: true, gaps: [] });
    const conversation = await store.conversation(imported.conversation.conversation_id); assert.ok(conversation);
    const historic = (await history(conversation, null, app.session)).flatMap((frame) => frame.messages)[0]; assert.ok(historic);
    assert.deepEqual(historic.presentation, finished.presentation); assert.equal(historic.text, finished.text); assert.equal(historic.tool?.status, finished.tool?.status);
    const retained = (await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items.find(ImportedItemEntry.is); assert.ok(retained);
    assert.equal(await store.indexText(retained), "Legacy indexed excerpt", "Display enrichment must not change embedding input");
    assert.equal(renderMessage(codexMessage(item, original, retained.id.toString())), `exec failed · exit 7 · ${finished.presentation.duration_ms} ms`, "Legacy formatted text remains stable");
    const calls = app.faux.state.callCount;
    unbind(); await app.session.close(BACKGROUND_CONTEXT); app = await fixture(directory);
    assert.deepEqual((await history(await app.session.root(BACKGROUND_CONTEXT), null, app.session)).flatMap((frame) => frame.messages), before);
    const reopened = await new HistoryStore(app.session).conversation(imported.conversation.conversation_id); assert.ok(reopened);
    assert.deepEqual((await history(reopened, null, app.session)).flatMap((frame) => frame.messages), [historic]);
    assert.equal(calls, 2); assert.equal(app.faux.state.callCount, 0);
  } finally { release(); await stop(); unbind(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("real file/coordination tools normalize known fields while arbitrary tool arguments remain lazy", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-live-tool-categories-")); const app = await fixture(directory);
  let stop = async () => {}, unbind = () => {};
  try {
    const task = await app.tasks.create({ title: "Inspect saved work", outcome: "Read actual agent state", model: fixtureModel });
    const child = await app.tasks.createAgent(task.id, { id: "review", title: "Review", outcome: "Check the fixture", input: "Read only", inputId: "child-input", model: fixtureModel });
    const conversation = await app.tasks.conversation(task.conversation_id);
    const generic = defineExtension({ name: "private-arguments", tools: [defineTool({ name: "private_tool", parameters: Type.Object({ token: Type.String() }),
      description: "Return public output", async execute() { return { output: [{ type: "text", text: "Public tool output" }] }; } })] }); app.registry.install(generic);
    unbind = app.executions.bind(conversation.id.toString(), { cwd: "/example", hosts: [], call: async (command) => {
      if (command.type === "write_file") return { type: "failed", message: "The destination is read-only" };
      assert.equal(command.type, "edit_file"); return { type: "written" };
    } });
    await conversation.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.host, app.tools.worker, generic] }, BACKGROUND_CONTEXT);
    const agents = fauxToolCall("read_agents", {}), edit = fauxToolCall("edit_file", { path: "example.rs", old: "PRIVATE_OLD_BODY", new: "PRIVATE_NEW_BODY" }),
      write = fauxToolCall("write_file", { path: "protected.rs", content: "PRIVATE_NEW_BODY" }), arbitrary = fauxToolCall("private_tool", { token: "PRIVATE_GENERIC_ARGUMENT" });
    app.faux.setResponses([fauxAssistantMessage([agents, edit, write, arbitrary], { stopReason: "toolUse" }), fauxAssistantMessage("Reviewed")]);
    const live: HistoryMessage[] = []; stop = await activity(app.session, conversation, () => {}, (message) => live.push(message));
    await (await conversation.submit({ type: "input", content: "Inspect the fixture" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT); await stop(); stop = async () => {};
    const completed = live.find((message) => message.tool?.call_id === agents.id && message.tool.status === "finished"); assert.ok(completed);
    assert.deepEqual(completed.presentation, { type: "agent_coordination", action: "list", sender_thread_id: conversation.id.toString(),
      receiver_thread_ids: [], agents: [{ thread_id: child.conversation_id, state: null }] });
    assert.equal(completed.text, "", "Agent records must not become transcript JSON receipts");
    const changed = live.find((message) => message.tool?.call_id === edit.id && message.tool.status === "finished"); assert.ok(changed);
    assert.deepEqual(changed.presentation, { type: "file_changes", changes: [{ path: "example.rs", operation: "update" }] });
    assert.equal(changed.text, "");
    const rejected = live.find((message) => message.tool?.call_id === write.id && message.tool.status === "failed"); assert.ok(rejected);
    assert.deepEqual(rejected.presentation, { type: "file_changes", changes: [{ path: "protected.rs", operation: null }] });
    assert.equal(rejected.text, "The destination is read-only");
    const output = live.find((message) => message.tool?.call_id === arbitrary.id && message.tool.status === "finished"); assert.ok(output);
    assert.equal(output.text, "Public tool output"); assert.deepEqual(output.presentation, { type: "tool", namespace: null });
    assert.doesNotMatch(JSON.stringify(live), /PRIVATE_(OLD_BODY|NEW_BODY|GENERIC_ARGUMENT)/);
    const details = await toolDetails(conversation, output.entry_id, arbitrary.id, app.session); assert.equal(details.type, "available");
    if (details.type === "available") { assert.equal(details.input.type, "text"); if (details.input.type === "text") assert.match(details.input.text, /PRIVATE_GENERIC_ARGUMENT/); }
    const saved = (await history(conversation, null, app.session)).flatMap((frame) => frame.messages);
    assert.deepEqual(saved.filter((message) => message.role === "tool"), live.filter((message) => message.role === "tool"));
    for (const message of saved) assert.ok(validEvent({ version: 1, id: 1, event: { type: "message", message } }));
    assert.equal(app.faux.state.callCount, 2);
  } finally { await stop(); unbind(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native Pi output limits cannot erase the owned command's typed exit or bounded display body", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-command-output-limit-")); let app = await fixture(directory);
  let unbind = () => {}, release = () => {}, entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT), call = fauxToolCall("exec", { program: "large-check", args: [] });
    unbind = app.executions.bind(root.id.toString(), { cwd: "/example", hosts: [], call: async () => {
      entered(); await held;
      return { type: "process", exit_code: 9, stdout: "Retained output\n" + "🦀".repeat(30_000), stderr: "", truncated: true };
    } });
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.host] }, BACKGROUND_CONTEXT);
    app.faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("Checked the bounded output")]);
    const running = await root.submit({ type: "input", content: "Run the large check" }, BACKGROUND_CONTEXT); await started;
    for (let index = 0; index < 25; index += 1) await root.commit((tx) => tx.appendEntry(root.id,
      { kind: "fixture.page-boundary", data: { index } }), BACKGROUND_CONTEXT);
    release(); await running.wait(BACKGROUND_CONTEXT);
    const entries = (await root.entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT)).items;
    const native = entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult"); assert.ok(native);
    const original = native.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    assert.throws(() => JSON.parse(original), "Exercise native output truncation of the existing JSON model channel");
    const page = await history(root, null, app.session); assert.ok(page.at(-1)?.next_cursor);
    assert.equal(page.flatMap((frame) => frame.messages).some((message) => message.tool?.status === "running"), false);
    const rows = page.flatMap((frame) => frame.messages).filter((message) => message.tool?.call_id === call.id && message.tool.status === "failed");
    const result = rows[0]; assert.ok(result); assert.equal(result.presentation?.type, "command");
    if (result.presentation?.type === "command") { assert.equal(result.presentation.command, "large-check"); assert.equal(result.presentation.exit_code, 9); }
    const body = rows.map((row) => row.text).join("");
    assert.ok(body.startsWith("Retained output\n🦀")); assert.ok(body.endsWith("\n[Output preview truncated]"));
    assert.ok(body.length <= 32_800); assert.doesNotMatch(body, /full original retained|<harness>|"exit_code"/);
    for (const row of rows) {
      const last = row.text.charCodeAt(row.text.length - 1), first = row.text.charCodeAt(0);
      assert.equal(last >= 0xd800 && last <= 0xdbff, false); assert.equal(first >= 0xdc00 && first <= 0xdfff, false);
    }
    unbind(); await app.session.close(BACKGROUND_CONTEXT); app = await fixture(directory);
    assert.deepEqual((await history(await app.session.root(BACKGROUND_CONTEXT), null, app.session)).flatMap((frame) => frame.messages)
      .filter((message) => message.tool?.call_id === call.id && message.tool.status === "failed"), rows);
    assert.equal(app.faux.state.callCount, 0);
  } finally { release(); unbind(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("actual delegation queues follow-ups and steers with matching live and reopened coordination actions", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-delegation-presentation-")); let app = await fixture(directory);
  let stop = async () => {}, unbind = () => {};
  try {
    const host = { host_id: null, rex_server: null, coordinator: null, name: "fixture", cwd: "/example", agent_program: "/fixture/agent" };
    const binding = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
      window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
    const task = await app.tasks.create({ title: "Existing work", outcome: "Continue this outcome", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const root = await app.session.root(BACKGROUND_CONTEXT); app.registry.install(app.tools.main);
    unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], model: fixtureModel, call: async (command) => {
      assert.equal(command.type, "resume_worker"); return { type: "written" };
    } });
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.main] }, BACKGROUND_CONTEXT);
    const queued = fauxToolCall("delegate_task", { task_id: task.id, input: "Queue the next pass", mode: "follow_up" }),
      steered = fauxToolCall("delegate_task", { task_id: task.id, input: "Correct this pass", mode: "steer" }),
      explicit = fauxToolCall("delegate_task", { task_id: task.id, input: "Continue this exact target", new_task: true, mode: "follow_up" });
    app.faux.setResponses([fauxAssistantMessage(queued, { stopReason: "toolUse" }), fauxAssistantMessage(steered, { stopReason: "toolUse" }),
      fauxAssistantMessage(explicit, { stopReason: "toolUse" }), fauxAssistantMessage("Inputs routed")]);
    const live: HistoryMessage[] = []; stop = await activity(app.session, root, () => {}, (message) => live.push(message));
    await (await root.submit({ type: "input", content: "Route both inputs" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT); await stop(); stop = async () => {};
    assert.equal((await app.tasks.list()).length, 1, "An explicit target still wins over the new-task flag in the actual producer");
    assert.deepEqual((await app.tasks.get(task.id)).pending.map((input) => input.mode), ["follow_up", "steer", "follow_up"]);
    for (const [id, action] of [[queued.id, "followup"], [steered.id, "send_input"], [explicit.id, "followup"]]) {
      const rows = live.filter((message) => message.tool?.call_id === id); assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.presentation?.type, "agent_coordination");
        if (row.presentation?.type === "agent_coordination") assert.equal(row.presentation.action, action);
      }
    }
    const saved = (await history(root, null, app.session)).flatMap((frame) => frame.messages);
    assert.deepEqual(saved.filter((message) => message.role === "tool"), live.filter((message) => message.role === "tool"));
    unbind(); await app.session.close(BACKGROUND_CONTEXT); app = await fixture(directory);
    assert.deepEqual((await history(await app.session.root(BACKGROUND_CONTEXT), null, app.session)).flatMap((frame) => frame.messages), saved);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await stop(); unbind(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
