import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentDoc, createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ConversationCatalog } from "../src/catalog.js";
import { ConversationViews } from "../src/conversation-views.js";
import { CoordinatorEnvironment } from "../src/environment.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import { HistoryStore } from "../src/history.js";
import { ConversationModels } from "../src/models.js";
import { validEvent } from "../src/protocol.js";
import { conversationSettings } from "../src/settings.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { history } from "../src/transcript.js";
import { fixtureModel } from "./model.js";

const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
async function open(directory: string) {
  const models = createModels(), faux = fauxProvider({ provider: "openai", api: "openai-responses", models: [{ id: "fixture", reasoning: true }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const harness = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const inference = new ConversationModels(models), tasks = new TaskStore(harness, inference), histories = new HistoryStore(harness);
  tasks.useHistory(histories);
  const environment = new CoordinatorEnvironment(harness); tasks.useEnvironment(environment);
  await environment.configure({ node: { host_id: binding.host_id, name: "fixture", rex_server: null, coordinator: null,
    agent_program: "/example/agent", home_directory: "/example/home", launch: { state_dir: null, runtime: null, config: null, instructions: null, model: fixtureModel } },
    settings: { model: fixtureModel, instructions: "Fixture guidance", context_repositories: [], sources: [] } });
  environment.setConnected([binding.host_id]);
  const catalog = new ConversationCatalog(harness, histories, tasks);
  const services = { harness, tasks, histories, inference, environment, catalog };
  const views = new ConversationViews(async () => services, () => {});
  return { ...services, views, faux, async imported() {
    return (await histories.import({ host_id: binding.host_id, thread: { id: "original-source", title: "Saved hardware work", cwd: "/example/project",
      created_at: 1, updated_at: 2, version: "one", version_reliable: true, archived: true, forked_from_id: null, parent_thread_id: null },
      items: [{ id: "original-message", turn_id: "one", kind: "userMessage", role: "user", text: "Original retained hardware context", version: "one",
        timestamp_ms: 1, order: 0, data: { type: "userMessage", text: "Original retained hardware context" }, assets: [] }], next_cursor: null, gaps: [], complete: true })).conversation;
  } };
}
function observe(app: Awaited<ReturnType<typeof open>>, id: number, conversationId: string, inputIds: readonly string[] = []) {
  const frames: RuntimeEventKind[] = [], listeners = new Set<() => void>();
  const running = app.views.attach(id, conversationId, (event) => {
    assert.ok(validEvent({ version: 1, id, event })); frames.push(event); for (const listener of listeners) listener();
  }, inputIds);
  return { frames, running, async until(predicate: () => boolean) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { const check = () => { if (predicate()) { listeners.delete(check); resolve(); } }; listeners.add(check); check(); });
  }, async detach() { app.views.detach(id); await running; } };
}
function input(conversation_id: string, input_id: string, text: string): Extract<RuntimeCommand, { type: "conversation_input" }> {
  return { type: "conversation_input", conversation_id, input_id, input: text, mode: "steer" };
}
function local(command: HostCommand): HostCommand { while (command.type === "on_node") command = command.command; return command; }

test("imported views and settings are inert; actual input uses one normal Rex actor and preserves live identity after detach", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-in-place-view-")), app = await open(directory);
  const controller = new AbortController(); let running: Promise<unknown> | undefined;
  const viewHandles: ReturnType<typeof observe>[] = [];
  try {
    const saved = await app.imported(), conversation = await app.tasks.conversation(saved.conversation_id);
    const initialAgent = await app.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    const initialRoot = await app.harness.commit((tx) => tx.conversation(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT);
    let changes = 0; const unsubscribe = app.harness.subscribeCommits((commit) => { changes += commit.changes.length; });
    const view = observe(app, 1, saved.conversation_id); viewHandles.push(view);
    await view.until(() => view.frames.some((event) => event.type === "conversation_ready"));
    assert.equal(changes, 0); unsubscribe();
    assert.deepEqual(await app.tasks.list(), []); assert.equal(app.faux.state.callCount, 0);
    assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT), initialAgent);
    assert.deepEqual(await app.harness.commit((tx) => tx.conversation(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT), initialRoot);
    const read = await conversationSettings(app.tasks, app.environment, { type: "conversation_settings", conversation_id: saved.conversation_id,
      task_id: null, agent_id: null, change: null, catalog: true });
    assert.equal(read.conversation_id, saved.conversation_id); assert.deepEqual(read.model, fixtureModel);
    assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT), initialAgent);
    await conversationSettings(app.tasks, app.environment, { type: "conversation_settings", conversation_id: saved.conversation_id,
      task_id: null, agent_id: null, change: { type: "set_reasoning", reasoning: "high" }, catalog: false });
    assert.deepEqual(await app.tasks.list(), [], "Changing an imported view's model must not adopt or execute it");
    let spawns = 0;
    const call: HostCall = async (command) => { assert.equal(command.type, "spawn_worker"); if (command.type !== "spawn_worker") throw new Error("Unexpected host operation");
      assert.equal(command.host.cwd, "/example/project"); spawns += 1; return { type: "spawned", binding }; };
    const receipts: RuntimeEventKind[] = [];
    await app.views.input(input(saved.conversation_id, "first", "Continue this hardware work"), call, (event) => receipts.push(event));
    assert.equal(spawns, 1); assert.ok(receipts.some((event) => event.type === "input_accepted")); assert.equal(app.faux.state.callCount, 0);
    const task = (await app.tasks.list())[0]; assert.ok(task?.worker.state === "bound");
    assert.equal(task.conversation_id, saved.conversation_id);
    app.faux.setResponses([fauxAssistantMessage("Continued the saved work"), fauxAssistantMessage("Applied the steering"), fauxAssistantMessage("Continued after view detach")]);
    let idleCount = 0, wake = () => {};
    const idle = async (count: number) => { while (idleCount < count) await new Promise<void>((resolve) => { wake = resolve; }); };
    running = app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: task.worker.allocation_id, binding,
      instructions: "Current guidance", model: fixtureModel, cwd: "/example/project", interactive: true }, () => () => {}, () => {}, [], undefined, undefined,
    { signal: controller.signal, async ready() {}, answer() {}, idle() { idleCount += 1; wake(); } });
    await idle(1); await view.until(() => view.frames.some((event) => event.type === "message" && event.message.text === "Continued the saved work"));
    const noAllocation: HostCall = async () => { throw new Error("An attached actor must wake without another Rex pane"); };
    await app.views.input(input(saved.conversation_id, "second", "Apply this additional context"), noAllocation, () => {}); await idle(2);
    await view.detach();
    await app.views.input(input(saved.conversation_id, "third", "Keep going after detach"), noAllocation, () => {}); await idle(3);
    await app.views.input(input(saved.conversation_id, "third", "Keep going after detach"), noAllocation, () => {});
    assert.equal(app.faux.state.callCount, 3); assert.equal(spawns, 1);
    const messages = (await history(conversation, null)).flatMap((frame) => frame.messages);
    assert.equal(messages.filter((message) => message.role === "user" && message.text === "Keep going after detach").length, 1);
    assert.ok(messages.some((message) => message.text === "Original retained hardware context"));
    const reconciled = observe(app, 2, saved.conversation_id, ["third", "not-sent"]); viewHandles.push(reconciled);
    await reconciled.until(() => reconciled.frames.some((event) => event.type === "input_placed" && event.input_id === "third"));
    const placed = reconciled.frames.find((event) => event.type === "input_placed"); assert.ok(placed?.type === "input_placed");
    assert.equal(placed.entry_id, messages.find((message) => message.role === "user" && message.text === "Keep going after detach")?.entry_id);
    assert.equal(reconciled.frames.some((event) => (event.type === "input_accepted" || event.type === "input_rejected") && event.input_id === "not-sent"), false);
    assert.equal(app.faux.state.callCount, 3, "Admission reconciliation must not run the model again");
  } finally { app.views.close(); await Promise.allSettled(viewHandles.map((view) => view.running)); controller.abort(); await running;
    app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("uncertain initial session creation keeps its accepted input and never repeats the external write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-view-uncertain-")), app = await open(directory);
  try {
    const saved = await app.imported(), receipts: RuntimeEventKind[] = []; let creates = 0;
    await assert.rejects(app.views.input(input(saved.conversation_id, "retained", "Continue saved work"), async () => {
      creates += 1; return { type: "creation_uncertain", session_id: binding.session_id };
    }, (event) => receipts.push(event)), /unconfirmed/u);
    assert.equal(creates, 1); assert.ok(receipts.some((event) => event.type === "input_accepted" && event.input_id === "retained"));
    const task = (await app.tasks.list())[0]; assert.ok(task?.worker.state === "uncertain");
    assert.equal(task.worker.session_id, binding.session_id); assert.deepEqual(task.pending.map((item) => item.id), ["retained"]);
    await assert.rejects(app.views.input(input(saved.conversation_id, "retained", "Continue saved work"), async () => {
      creates += 1; return { type: "spawned", binding };
    }, () => {}), /reconciliation/u);
    assert.equal(creates, 1); assert.equal(app.faux.state.callCount, 0);
  } finally { app.views.close(); app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a closed child resumes its own conversation in the existing task folder and uncertain recovery retains its outbox", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-child-view-")), app = await open(directory);
  let view: ReturnType<typeof observe> | undefined;
  try {
    const host = await app.environment.defaultHost(await app.environment.hosts("/example/project", binding.host_id, [])); assert.ok(host);
    const task = await app.tasks.create({ title: "Hardware task", outcome: "Finish the hardware", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "review", title: "Review hardware", outcome: "Review", input: "Initial review", inputId: "review-first" });
    const childBinding = { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" };
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: childBinding }));
    const original = (await app.tasks.get(task.id)).agents[0]; assert.ok(original?.worker.state === "bound");
    view = observe(app, 1, child.conversation_id); await view.until(() => view?.frames.some((event) => event.type === "conversation_ready") ?? false);
    assert.equal(app.faux.state.callCount, 0);
    const replaced = { ...childBinding, block_id: "block:66666666-6666-4666-8666-666666666666" }; let resumes = 0;
    await app.views.input(input(child.conversation_id, "review-next", "Additional review context"), async (command) => {
      const operation = local(command);
      if (operation.type === "inspect_worker") return { type: "worker_presence", presence: { state: "present", running: false } };
      assert.equal(operation.type, "resume_agent_worker"); if (operation.type !== "resume_agent_worker") throw new Error("Unexpected recovery operation");
      assert.equal(operation.agent_id, child.id); assert.equal(operation.binding.session_id, binding.session_id); resumes += 1;
      return { type: "spawned", binding: replaced };
    }, () => {});
    const restored = (await app.tasks.get(task.id)).agents[0]; assert.ok(restored?.worker.state === "bound");
    assert.equal(restored.conversation_id, child.conversation_id); assert.equal(restored.worker.binding.session_id, binding.session_id); assert.equal(resumes, 1);
    assert.deepEqual(restored.pending.map((item) => item.id), ["review-first", "review-next"]);
    await assert.rejects(app.views.input(input(child.conversation_id, "review-uncertain", "More context"), async (command) =>
      local(command).type === "inspect_worker" ? { type: "worker_presence", presence: { state: "missing_terminal" } }
        : { type: "creation_uncertain", session_id: binding.session_id }, () => {}), /not confirmed/u);
    const uncertain = (await app.tasks.get(task.id)).agents[0]; assert.ok(uncertain?.worker.state === "resume_uncertain");
    assert.deepEqual(uncertain.worker.binding, replaced); assert.ok(uncertain.pending.some((item) => item.id === "review-uncertain"));
    let writes = 0;
    await assert.rejects(app.views.input(input(child.conversation_id, "retry-uncertain", "Retain this too"), async (command) => {
      if (local(command).type !== "inspect_worker") writes += 1;
      return { type: "worker_presence", presence: { state: "missing_terminal" } };
    }, () => {}), /unconfirmed/u);
    assert.equal(writes, 0, "Uncertain pane creation must only inspect its retained binding");
  } finally { app.views.close(); await view?.running; app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("active child steering reuses its actor and closed child or task folders recover the same retained conversation", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-child-lifecycle-")), app = await open(directory);
  const controller = new AbortController(); let running: Promise<unknown> | undefined, view: ReturnType<typeof observe> | undefined;
  try {
    const host = await app.environment.defaultHost(await app.environment.hosts("/example/project", binding.host_id, [])); assert.ok(host);
    const task = await app.tasks.create({ title: "Parent task", outcome: "Complete the work", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "child", title: "Child review", outcome: "Review the work", input: "First review", inputId: "first" });
    const initial = { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" };
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: initial }));
    const worker = (await app.tasks.get(task.id)).agents[0]?.worker; assert.ok(worker?.state === "bound");
    app.faux.setResponses([fauxAssistantMessage("First review done"), fauxAssistantMessage("Steering reviewed"),
      fauxAssistantMessage("Closed pane review done"), fauxAssistantMessage("Closed folder review done")]);
    const command: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id, agent_id: child.id,
      allocation_id: worker.allocation_id, binding: initial, instructions: "Current rules", model: fixtureModel, cwd: host.cwd, interactive: true };
    let idles = 0, wake = () => {};
    const idle = async (count: number) => { while (idles < count) await new Promise<void>((resolve) => { wake = resolve; }); };
    running = app.tasks.run(command, () => () => {}, () => {}, [], undefined, undefined,
      { signal: controller.signal, async ready() {}, answer() {}, idle() { idles += 1; wake(); } });
    await idle(1);
    await app.views.input(input(child.conversation_id, "second", "Additional review direction"), async () => { throw new Error("Active child must not allocate another terminal"); }, () => {});
    await idle(2); assert.equal(app.faux.state.callCount, 2);
    controller.abort(); await running; running = undefined;
    const callsBeforeBrowse = app.faux.state.callCount;
    view = observe(app, 2, child.conversation_id); await view.until(() => view?.frames.some((event) => event.type === "conversation_ready") ?? false);
    assert.equal(app.faux.state.callCount, callsBeforeBrowse, "Browsing the closed child must stay inert");
    const replacement = { ...initial, block_id: "block:66666666-6666-4666-8666-666666666666" }; let resumes = 0;
    await app.views.input(input(child.conversation_id, "third", "Continue after closing the child tab"), async (command) => {
      const operation = local(command);
      if (operation.type === "inspect_worker") return { type: "worker_presence", presence: { state: "missing_terminal" } };
      assert.equal(operation.type, "resume_agent_worker"); if (operation.type !== "resume_agent_worker") throw new Error("Unexpected recovery");
      assert.equal(operation.agent_id, child.id); resumes += 1; return { type: "spawned", binding: replacement };
    }, () => {});
    assert.equal(resumes, 1);
    const resumed = (await app.tasks.get(task.id)).agents[0]; assert.ok(resumed?.worker.state === "bound");
    await app.tasks.run({ ...command, allocation_id: resumed.worker.allocation_id, binding: replacement, interactive: false }, () => () => {}, () => {});
    assert.equal(app.faux.state.callCount, 3);
    const nextParent = { ...binding, session_id: "session:77777777-7777-4777-8777-777777777777" };
    const nextChild = { ...nextParent, block_id: "block:88888888-8888-4888-8888-888888888888" }; let folders = 0, panes = 0;
    await app.views.input(input(child.conversation_id, "fourth", "Continue after closing the task folder"), async (command) => {
      const operation = local(command);
      if (operation.type === "inspect_worker") return { type: "worker_presence", presence: { state: "missing_session" } };
      if (operation.type === "spawn_worker") { folders += 1; return { type: "spawned", binding: nextParent }; }
      assert.equal(operation.type, "spawn_subagent"); if (operation.type !== "spawn_subagent") throw new Error("Unexpected folder recovery");
      assert.equal(operation.parent.session_id, nextParent.session_id); panes += 1; return { type: "spawned", binding: nextChild };
    }, () => {});
    assert.equal(folders, 1); assert.equal(panes, 1);
    const recovered = (await app.tasks.get(task.id)).agents[0]; assert.ok(recovered?.worker.state === "bound");
    assert.equal(recovered.conversation_id, child.conversation_id);
    await app.tasks.run({ ...command, allocation_id: recovered.worker.allocation_id, binding: nextChild, interactive: false }, () => () => {}, () => {});
    assert.equal(app.faux.state.callCount, 4);
    const conversation = await app.tasks.conversation(child.conversation_id), messages = (await history(conversation, null)).flatMap((frame) => frame.messages);
    assert.equal(messages.filter((message) => message.role === "user").length, 4, "Each actual input must appear exactly once across recovery");
  } finally { app.views.close(); await view?.running; controller.abort(); await running;
    app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a stale child missing-folder read cannot replace a parent folder confirmed alive afterward", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-child-parent-race-")), app = await open(directory);
  let release = () => {};
  try {
    const host = await app.environment.defaultHost(await app.environment.hosts("/example/project", binding.host_id, [])); assert.ok(host);
    const task = await app.tasks.create({ title: "Parent", outcome: "Continue", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "child", title: "Review", outcome: "Review", input: "Review", inputId: "first" });
    const childBinding = { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" };
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: childBinding }));
    let entered = () => {}; const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; }); let inspected = 0, folders = 0;
    const recovering = app.tasks.dispatchAgent(task.id, child.id, async (command) => {
      const operation = local(command);
      if (operation.type === "inspect_worker") {
        inspected += 1;
        if (inspected === 1) { entered(); await gate; return { type: "worker_presence", presence: { state: "missing_session" } }; }
        return { type: "worker_presence", presence: { state: "present", running: true } };
      }
      if (operation.type === "spawn_worker") { folders += 1; return { type: "spawned", binding }; }
      if (operation.type === "spawn_subagent") return { type: "spawned", binding: childBinding };
      throw new Error("Unexpected recovery operation");
    });
    await started;
    await app.tasks.dispatch(task.id, host, async (command) => { assert.equal(command.type, "resume_worker"); return { type: "written" }; });
    release(); await recovering;
    assert.equal(folders, 0, "A stale child read cannot authorize a new task folder after a newer parent confirmation");
    assert.equal((await app.tasks.get(task.id)).conversation_id, task.conversation_id);
  } finally { release(); app.views.close(); app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("closed-child input is acknowledged at durable admission before held Rex inspection completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-child-ack-")), app = await open(directory);
  let release = () => {}, sending: Promise<void> | undefined;
  try {
    const host = await app.environment.defaultHost(await app.environment.hosts("/", null, [])); assert.ok(host);
    const task = await app.tasks.create({ title: "Parent", outcome: "Continue", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "child", title: "Child", outcome: "Review", input: "Review", inputId: "first" });
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" } }));
    let entered = () => {}; const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; }), receipts: RuntimeEventKind[] = [];
    sending = app.views.input(input(child.conversation_id, "next", "Continue this child"), async () => {
      entered(); await gate; return { type: "worker_presence", presence: { state: "present", running: true } };
    }, (event) => receipts.push(event));
    await started;
    assert.ok((await app.tasks.get(task.id)).agents[0]?.pending.some((item) => item.id === "next"));
    assert.ok(receipts.some((event) => event.type === "input_accepted" && event.input_id === "next"), "A saved child input must be acknowledged before waiting for Rex");
    release(); await sending;
  } finally { release(); await sending?.catch(() => {}); app.views.close(); app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("two missing child folders share parent recovery and retain both admitted inputs without another folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-children-folder-race-")), app = await open(directory);
  let releaseInspections = () => {}, releaseCreation = () => {}; const pending: Promise<void>[] = [];
  try {
    const host = await app.environment.defaultHost(await app.environment.hosts("/", null, [])); assert.ok(host);
    const task = await app.tasks.create({ title: "Parent", outcome: "Continue", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const children = await Promise.all(["alpha", "beta"].map((id) => app.tasks.createAgent(task.id, { id, title: id, outcome: "Review", input: "Initial review", inputId: id + "-first" })));
    for (const child of children) await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: { ...binding, block_id: child.id } }));
    let inspected = 0, bothEntered = () => {}, creating = () => {};
    const initial = new Promise<void>((resolve) => { bothEntered = resolve; }), inspections = new Promise<void>((resolve) => { releaseInspections = resolve; });
    const creationStarted = new Promise<void>((resolve) => { creating = resolve; }), creation = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const next = { ...binding, session_id: "session:77777777-7777-4777-8777-777777777777" }; let folders = 0, panes = 0;
    const receipts: RuntimeEventKind[] = [];
    const call: HostCall = async (command) => {
      const operation = local(command);
      if (operation.type === "inspect_worker") {
        inspected += 1; if (inspected <= 2) { if (inspected === 2) bothEntered(); await inspections; }
        return { type: "worker_presence", presence: { state: "missing_session" } };
      }
      if (operation.type === "spawn_worker") { folders += 1; creating(); await creation; return { type: "spawned", binding: next }; }
      assert.equal(operation.type, "spawn_subagent"); if (operation.type !== "spawn_subagent") throw new Error("Unexpected recovery");
      assert.equal(operation.parent.session_id, next.session_id); panes += 1;
      return { type: "spawned", binding: { ...next, block_id: operation.agent_id } };
    };
    for (const child of children) pending.push(app.views.input(input(child.conversation_id, child.id + "-next", "Retained follow-up"), call, (event) => receipts.push(event)));
    const settled = Promise.allSettled(pending);
    await initial; releaseInspections(); await creationStarted; releaseCreation(); await settled;
    for (const child of children) {
      const actor = (await app.tasks.get(task.id)).agents.find((agent) => agent.id === child.id); assert.ok(actor);
      assert.ok(receipts.some((event) => event.type === "input_accepted" && event.input_id === child.id + "-next"));
      assert.equal(actor.pending.filter((item) => item.id === child.id + "-next").length, 1);
      if (actor.worker.state === "unassigned") await app.tasks.dispatchAgent(task.id, child.id, call);
    }
    assert.equal(folders, 1); assert.equal(panes, 2); assert.equal(app.faux.state.callCount, 0);
    assert.ok((await app.tasks.get(task.id)).agents.every((agent) => agent.worker.state === "bound"));
  } finally { releaseInspections(); releaseCreation(); await Promise.allSettled(pending); app.views.close(); app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a detaching parent claims folder ownership before inspection so child recovery cannot overtake its read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-parent-guard-")), app = await open(directory);
  const controller = new AbortController(); let releaseReady = () => {}, releaseInspection = () => {};
  let running: Promise<unknown> | undefined, recovering: Promise<unknown> | undefined;
  try {
    const host = await app.environment.defaultHost(await app.environment.hosts("/", null, [])); assert.ok(host);
    const task = await app.tasks.create({ title: "Parent", outcome: "Continue", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "child", title: "Review", outcome: "Review", input: "Review", inputId: "first" });
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" } }));
    let enteredReady = () => {}; const ready = new Promise<void>((resolve) => { enteredReady = resolve; }), readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const worker = (await app.tasks.get(task.id)).worker; assert.ok(worker.state === "bound");
    running = app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: worker.allocation_id, binding, instructions: "Current rules", model: fixtureModel, cwd: host.cwd, interactive: true },
      () => () => {}, () => {}, [], undefined, undefined, { signal: controller.signal, async ready() { enteredReady(); await readyGate; }, async fence() { releaseReady(); }, answer() {}, idle() {} });
    await ready; controller.abort();
    let inspected = () => {}; const entered = new Promise<void>((resolve) => { inspected = resolve; }), held = new Promise<void>((resolve) => { releaseInspection = resolve; });
    recovering = app.tasks.dispatch(task.id, host, async () => { inspected(); await held; return { type: "worker_presence", presence: { state: "present", running: true } }; }).catch((error: unknown) => error);
    await entered;
    let childReads = 0; const receipts: RuntimeEventKind[] = [];
    await assert.rejects(app.views.input(input(child.conversation_id, "retained", "Keep this follow-up"), async () => {
      childReads += 1; return { type: "worker_presence", presence: childReads === 1 ? { state: "missing_session" } : { state: "present", running: true } };
    }, (event) => receipts.push(event)), /recovering/u);
    assert.equal(childReads, 1, "A child cannot confirm or replace the parent's folder while its inspection owns recovery");
    assert.ok(receipts.some((event) => event.type === "input_accepted" && event.input_id === "retained"));
    assert.ok((await app.tasks.get(task.id)).agents[0]?.pending.some((item) => item.id === "retained"));
    releaseInspection(); await recovering; releaseReady(); await running; running = undefined;
    assert.equal(app.faux.state.callCount, 0);
  } finally { releaseInspection(); releaseReady(); controller.abort(); await recovering; await running;
    app.views.close(); app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
