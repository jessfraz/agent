import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentDoc, createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CoordinatorEnvironment } from "../src/environment.js";
import { ConversationModels, DEFAULT_MODEL, ModelError } from "../src/models.js";
import { validEvent, validRequest } from "../src/protocol.js";
import { conversationSettings } from "../src/settings.js";
import { TaskStore } from "../src/tasks.js";
import type { ConversationChange } from "../src/generated/ConversationChange.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { ModelSelection } from "../src/generated/ModelSelection.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { HostResult } from "../src/generated/HostResult.js";

const selected: ModelSelection = { provider: "openai", model_id: "fixture", reasoning: null, fast: false };
const alternate: ModelSelection = { provider: "anthropic", model_id: "other", reasoning: null, fast: false };
async function open(directory: string) {
  const models = createModels();
  const first = fauxProvider({ provider: "openai", api: "openai-responses", models: [{ id: "fixture", reasoning: true }], tokensPerSecond: 1_000_000 });
  const second = fauxProvider({ provider: "anthropic", models: [{ id: "other", reasoning: false }], tokensPerSecond: 1_000_000 });
  models.setProvider(first.provider); models.setProvider(second.provider);
  const inference = new ConversationModels(models);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, inference), environment = new CoordinatorEnvironment(session);
  await environment.configure({ node: null, settings: { model: selected, instructions: "", context_repositories: [], sources: [] } });
  return { first, second, inference, session, tasks, environment,
    async settings(change: ConversationChange | null, target: { task_id: string; agent_id?: string } | undefined = undefined, catalog = false) {
      const command: Extract<RuntimeCommand, { type: "conversation_settings" }> = { type: "conversation_settings",
        task_id: target?.task_id ?? null, agent_id: target?.agent_id ?? null, change, catalog };
      assert.ok(validRequest({ version: 1, id: 1, command }));
      const settings = await conversationSettings(tasks, environment, command);
      assert.ok(validEvent({ version: 1, id: 1, event: { type: "conversation_settings", settings } }));
      return settings;
    } };
}

test("local settings use the native catalog, preserve fast through reopen, and never submit chat input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-settings-")); let app = await open(directory);
  try {
    const initial = await app.settings(null, undefined, true);
    assert.deepEqual(initial.model, selected); assert.deepEqual(initial.catalog.map((model) => [model.provider, model.model_id]), [["anthropic", "other"], ["openai", "fixture"]]);
    assert.equal(initial.catalog.find((model) => model.provider === "openai")?.fast, true);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    const before = (await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id);
    await app.settings({ type: "set_reasoning", reasoning: "high" });
    assert.equal((await app.settings({ type: "set_fast", mode: "toggle" })).model.fast, true);
    const expected = { ...selected, reasoning: "high", fast: true };
    assert.deepEqual((await app.settings(null)).model, expected);
    assert.equal(app.first.state.callCount + app.second.state.callCount, 0);
    assert.deepEqual((await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id), before);
    assert.deepEqual(await app.tasks.list(), []);
    assert.deepEqual(await app.environment.model(null), selected, "Conversation changes must not replace defaults for new work");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.deepEqual((await app.settings(null)).model, expected);
    const restored = await app.session.root(BACKGROUND_CONTEXT);
    assert.deepEqual(await app.inference.legacy(restored, alternate), expected);
    assert.deepEqual(await app.inference.configureCurrent(restored, alternate, { instructions: "Fresh project guidance" }), expected,
      "Loading startup context must not replace the saved conversation selection");
    assert.equal((await app.session.snapshot(AgentDoc, restored.id, BACKGROUND_CONTEXT))?.instructions, "Fresh project guidance");
    assert.equal(app.first.state.callCount + app.second.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("model changes adapt compatible settings and reject invalid changes without partial actor writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-settings-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Review a component", outcome: "Finish the review", model: selected });
    const target = { task_id: task.id };
    await app.settings({ type: "set_selection", model: { ...selected, reasoning: "high", fast: true } }, target);
    const changed = await app.settings({ type: "set_model", provider: "anthropic", model_id: "other" }, target);
    assert.deepEqual(changed.model, alternate, "Unsupported fast/reasoning options must not follow a model switch");
    assert.deepEqual((await app.tasks.get(task.id)).model, alternate);
    const conversation = await app.tasks.conversation(task.conversation_id);
    const native = await app.session.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    await assert.rejects(app.settings({ type: "set_fast", mode: "on" }, target), ModelError);
    await assert.rejects(app.settings({ type: "set_model", provider: null, model_id: "missing" }, target), ModelError);
    assert.deepEqual((await app.tasks.get(task.id)).model, alternate);
    assert.deepEqual(await app.session.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT), native);
    const child = await app.tasks.createAgent(task.id, { id: "fixture-child", title: "Inspect fit", outcome: "Inspect the fit", input: "Check the component", inputId: "child-input" });
    await app.settings({ type: "set_model", provider: "openai", model_id: "fixture" }, { task_id: task.id, agent_id: child.id });
    const saved = await app.tasks.get(task.id);
    assert.deepEqual(saved.model, alternate); assert.deepEqual(saved.agents[0]?.model, selected);
    await assert.rejects(app.settings(null, { task_id: task.id, agent_id: "missing" }), /unavailable/);
    assert.equal(app.first.state.callCount + app.second.state.callCount, 0);
    assert.equal((await app.tasks.list()).length, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent toggles serialize and a busy native turn changes model only on its next generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-settings-busy-")); const app = await open(directory);
  let release = () => {};
  try {
    await app.settings({ type: "set_selection", model: selected });
    await Promise.all([app.settings({ type: "set_fast", mode: "toggle" }), app.settings({ type: "set_fast", mode: "toggle" })]);
    assert.equal((await app.settings(null)).model.fast, false);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    let entered = () => {}; const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    app.first.setResponses([async () => { entered(); await held; return fauxAssistantMessage("Original request completed"); }]);
    const input = await root.submit({ type: "input", content: "Finish this request" }, BACKGROUND_CONTEXT); await started;
    await app.settings({ type: "set_model", provider: "anthropic", model_id: "other" });
    release(); assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "done");
    app.second.setResponses([fauxAssistantMessage("New model handled the next request")]);
    assert.equal((await (await root.submit({ type: "input", content: "Continue" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(app.first.state.callCount, 1); assert.equal(app.second.state.callCount, 1);
    assert.deepEqual((await app.settings(null)).model, alternate);
  } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("the real bridge changes busy settings without prompting and uses them after reconnect", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-settings-bridge-")), queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({ "held-start": [{ tool: "exec", args: { program: "held", args: [] } }, { text: "Current request completed" }],
    "after-reopen": [{ text: "Saved settings handled the reopened chat" }] }));
  let held: { id: number; call_id: string } | undefined, entered = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const openBridge = () => {
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const lines = createInterface({ input: child.stdout }), frames: { id: number; event: RuntimeEventKind }[] = [];
    const pending = new Map<number, { frames: RuntimeEventKind[]; resolve(events: RuntimeEventKind[]): void }>();
    let sequence = 0, errors = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
    lines.on("line", (line) => {
      const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame);
      const waiting = pending.get(frame.id); waiting?.frames.push(frame.event);
      if (frame.event.type === "done") { pending.delete(frame.id); waiting?.resolve(waiting.frames); }
      if (frame.event.type !== "host_call") return;
      let command = frame.event.command; while (command.type === "on_node") command = command.command;
      if (command.type === "exec") { assert.equal(command.program, "held"); held = { id: frame.id, call_id: frame.event.call_id }; entered(); return; }
      const result: HostResult = command.type === "reload_guidance" ? { type: "shared_guidance", global: { text: "", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] }
        : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
        : command.type === "embed" ? { type: "embeddings", batch: { space: { id: "fixture", model_revision: "fixture", model_digest: "fixture", dimensions: 3,
          pooling: "last", normalization: "l2", instruction_version: 1 }, vectors: command.texts.map(() => [1, 0, 0]) } }
        : { type: "failed", message: "Unexpected synthetic host operation" };
      send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
    });
    return { child, frames, send, request(command: RuntimeCommand) {
      const id = ++sequence; const response = new Promise<RuntimeEventKind[]>((resolve) => { pending.set(id, { frames: [], resolve }); });
      send(id, command); return { id, response };
    }, async close() { child.stdin.end(); assert.equal(await closed, 0, errors); lines.close(); },
    async stop() { child.kill(); await closed; lines.close(); } };
  };
  let peer = openBridge();
  t.after(async () => { await peer.stop(); await rm(directory, { recursive: true, force: true }); });
  const control = (change: ConversationChange | null): RuntimeCommand => ({ type: "conversation_settings", task_id: null, agent_id: null, change, catalog: false });
  const chat = (input: string): RuntimeCommand => ({ type: "chat", input, instructions: "", model: null, origin_host_id: null, cwd: "/example/project", hosts: [] });
  const configure = async () => {
    const node = { host_id: "11111111-1111-4111-8111-111111111111", name: "fixture", rex_server: null, home_directory: "/example", coordinator: null,
      agent_program: "/example/agent", launch: { state_dir: null, runtime: null, config: null, instructions: null, model: DEFAULT_MODEL } };
    await peer.request({ type: "configure_coordinator", bootstrap: { node,
      settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } }).response;
    await peer.request({ type: "set_connected_nodes", host_ids: [node.host_id] }).response;
  };
  try {
    await configure();
    const current = peer.request(chat("held-start")); await started;
    await peer.request(control({ type: "set_fast", mode: "on" })).response;
    const configured = await peer.request(control({ type: "set_reasoning", reasoning: "low" })).response;
    assert.ok(configured.some((event) => event.type === "conversation_settings" && event.settings.model.fast && event.settings.model.reasoning === "low"));
    assert.ok(peer.frames.some((frame) => frame.id === current.id && frame.event.type === "conversation_settings" && frame.event.settings.model.fast));
    const requestsBeforeRelease = (await readFile(queue + ".requests", "utf8")).trim().split("\n");
    assert.equal(requestsBeforeRelease.length, 1, "Local controls must not trigger another provider generation");
    assert.ok(held); peer.send(held.id, { type: "host_reply", call_id: held.call_id,
      result: { type: "process", exit_code: 0, stdout: "Completed", stderr: "", truncated: false } });
    const completed = await current.response;
    assert.ok(completed.some((event) => event.type === "answer" && event.text === "Current request completed"));
    await peer.close(); peer = openBridge(); await configure();
    const saved = await peer.request(control(null)).response;
    assert.ok(saved.some((event) => event.type === "conversation_settings" && event.settings.model.fast && event.settings.model.reasoning === "low"));
    assert.ok((await peer.request(chat("after-reopen")).response).some((event) => event.type === "answer" && event.text === "Saved settings handled the reopened chat"));
    const tasks = await peer.request({ type: "list_tasks" }).response;
    assert.ok(tasks.some((event) => event.type === "tasks" && event.tasks.length === 0));
    const requests: unknown[] = (await readFile(queue + ".requests", "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.length, 3);
    for (const value of requests.slice(1)) {
      assert.ok(value !== null && typeof value === "object" && "body" in value);
      const body = value.body; assert.ok(body !== null && typeof body === "object" && "service_tier" in body);
      assert.equal(body.service_tier, "priority");
    }
  } finally { await peer.stop(); await rm(directory, { recursive: true, force: true }); }
});
