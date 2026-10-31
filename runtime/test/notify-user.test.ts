import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { watchMainNotices } from "../src/main_observation.js";
import { ConversationModels } from "../src/models.js";
import { SourceJournal, createSourceTools } from "../src/sources.js";
import { publishMainNotice, TaskStore } from "../src/tasks.js";
import { Executions } from "../src/tools.js";
import { isUserNotice } from "../src/transcript.js";
import { fixtureModel } from "./model.js";

const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111",
  session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333",
  block_id: "block:44444444-4444-4444-8444-444444444444" };
const host = { host_id: null, name: "fixture", rex_server: null, coordinator: null,
  cwd: "/workspace/example", agent_program: "/example/agent" };
async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const registry = createRegistry(), session = await Harness.open(await SqliteStorage.open(database),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)), executions = new Executions();
  const sources = new SourceJournal(session, tasks, executions), tools = createSourceTools(sources, executions);
  registry.install(tools.main); registry.install(tools.worker);
  return { session, tasks, executions, sources, tools, faux };
}
async function notices(conversation: Conversation) {
  return (await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.filter(isUserNotice);
}

const cases: { child: boolean; main: "idle" | "busy" | "reset" }[] = [
  { child: false, main: "idle" }, { child: true, main: "idle" },
  { child: false, main: "busy" }, { child: false, main: "reset" },
];
for (const { child, main } of cases) test(`a running ${child ? "child" : "worker"} publishes one curated update with main ${main} and retains it across replay/reopen`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notify-user-")); let app = await open(directory);
  let stop = () => {}, release = () => {}, releaseMain = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const heldMain = new Promise<void>((resolve) => { releaseMain = resolve; });
  let execution: Promise<unknown> | undefined;
  let mainExecution: Promise<unknown> | undefined;
  try {
    const task = await app.tasks.create({ title: "Continue the requested job", outcome: "Verify the result", model: fixtureModel });
    await app.tasks.enqueue(task.id, "Continue authorized work.");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    let actor = await app.tasks.get(task.id), agentId: string | undefined;
    if (child) {
      const agent = await app.tasks.createAgent(task.id, { id: "focused-check", title: "Focused check", outcome: "Verify one part",
        input: "Continue the bounded check.", inputId: "child-input" });
      agentId = agent.id;
      await app.tasks.dispatchAgent(task.id, agent.id, async () => ({ type: "spawned", binding }));
      actor = await app.tasks.get(task.id);
    }
    const worker = agentId === undefined ? actor : actor.agents.find((agent) => agent.id === agentId);
    assert.ok(worker?.worker.state === "bound");
    const run: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id, ...(agentId === undefined ? {} : { agent_id: agentId }),
      allocation_id: worker.worker.allocation_id, binding, instructions: "", model: fixtureModel, cwd: host.cwd };
    const root = await app.session.root(BACKGROUND_CONTEXT), live: string[] = [];
    if (main !== "idle") {
      let mainStarted = () => {};
      const started = new Promise<void>((resolve) => { mainStarted = resolve; });
      await root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
      app.faux.setResponses([async () => {
        mainStarted(); await heldMain; return fauxAssistantMessage("The main request is complete.");
      }]);
      mainExecution = (await root.submit({ type: "input", content: "Continue the main request." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      await started;
    }
    if (main === "reset") await root.submit({ type: "write", requestId: "queued-reset",
      entry: { kind: "test.reset", head: "self" } }, BACKGROUND_CONTEXT);
    let published = () => {};
    const publication = new Promise<void>((resolve) => { published = resolve; });
    stop = await watchMainNotices(app.session, root, (event) => {
      if (event.type === "message") { live.push(event.message.entry_id); published(); }
    });
    let reached = () => {};
    const continuing = new Promise<void>((resolve) => { reached = resolve; });
    const text = "The useful result is verified; the remaining authorized work continues.";
    const callId = "mid-job-update";
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("notify_user", { text }, { id: callId }), { stopReason: "toolUse" }),
      async (input) => {
        assert.ok(input.messages.some((message) => message.role === "toolResult" && !message.isError &&
          message.content.some((part) => part.type === "text" && part.text === (main === "reset"
            ? "Queued for the main chat; not yet delivered." : "Published to the main chat."))));
        reached(); await held; return fauxAssistantMessage("The job is now complete.");
      },
    ]);
    execution = app.tasks.run(run, (conversation) => app.executions.bind(conversation.id.toString(), {
      cwd: host.cwd, hosts: [host], role: "worker", call: async () => { throw new Error("No host effects are needed"); },
      notify: () => { throw new Error("Canonical publication must not invoke a duplicate direct callback"); },
    }), [app.tools.worker]);
    await Promise.race([continuing, execution.then(() => { throw new Error("The worker ended before publishing its update"); })]);
    assert.equal(app.tasks.isRunning(task.id), true, "The user update must arrive while the job is still running");
    if (main === "reset") {
      assert.equal((await notices(root)).length, 0);
      assert.deepEqual(live, [], "A queued reset must retain Pi's ordered publication boundary");
      releaseMain(); await mainExecution; mainExecution = undefined;
    }
    const saved = await notices(root); assert.equal(saved.length, 1);
    await publication;
    const entry = saved[0]; assert.ok(entry);
    assert.deepEqual(entry.data, { task_id: task.id, source_conversation_id: worker.conversation_id,
      source_entry_id: (await app.tasks.origin(await app.tasks.conversation(worker.conversation_id), callId)).id.toString(), text });
    assert.deepEqual(live, [entry.id.toString()]);
    await app.sources.notify(worker.conversation_id, callId, [], task.id, text, () => {});
    assert.equal((await notices(root)).length, 1, "Replaying the same native call must not append a second notice");
    assert.deepEqual(live, [entry.id.toString()]);
    releaseMain(); await mainExecution; mainExecution = undefined;
    assert.equal((await root.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text === text)).length, 1,
    "The main model must retain exactly one copy of the notice");
    release(); await execution; execution = undefined;
    assert.equal((await notices(root)).length, 1, "The eventual worker final must not republish the update");
    stop(); await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const reopened = await app.session.root(BACKGROUND_CONTEXT);
    await app.sources.notify(worker.conversation_id, callId, [], task.id, text, () => {});
    assert.deepEqual((await notices(reopened)).map((notice) => notice.id), [entry.id]);
    assert.equal(app.faux.state.callCount, 0, "Publication recovery must not run another model turn");
  } finally { releaseMain(); release(); await mainExecution?.catch(() => {}); await execution?.catch(() => {}); stop(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

for (const legacy of [false, true]) test(`${legacy ? "legacy queued" : "visible"} notice retains one model contribution across reopen while main is busy`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notice-reopen-")); let app = await open(directory);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let execution: Promise<unknown> | undefined;
  try {
    let root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    let started = () => {};
    const running = new Promise<void>((resolve) => { started = resolve; });
    app.faux.setResponses([async (_input, options) => {
      const signal = options?.signal; assert.ok(signal);
      await Promise.race([held, new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        started();
      })]);
      return fauxAssistantMessage("Main completed.");
    }]);
    execution = (await root.submit({ type: "input", content: "Continue main work." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    void execution.catch(() => {});
    await running;
    let source = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const notice = { key: "restart-notice", text: "A verified background result is ready.", events: [] };
    const origin = await source.commit((tx) => tx.appendEntry(source.id, { kind: "pi.assistant",
      model: [fauxAssistantMessage(notice.text)] }), BACKGROUND_CONTEXT);
    const requestId = "notice:" + origin.id.toString() + ":" + notice.key;
    if (legacy) await root.submit({ type: "write", requestId, entry: { kind: "agent.user_notice",
      data: { task_id: null, source_conversation_id: source.id.toString(), source_entry_id: origin.id.toString() },
      model: [fauxAssistantMessage(notice.text)] } }, BACKGROUND_CONTEXT);
    assert.equal(await publishMainNotice(app.session, source, origin, null, [], notice), legacy ? "queued" : "published");
    const queuedId = legacy ? requestId : "notice-context:" + JSON.stringify([origin.id.toString(), notice.key]);
    assert.equal((await root.commit((tx) => tx.submissionByRequest(root.id, queuedId), BACKGROUND_CONTEXT))?.status, "queued");
    assert.equal((await notices(root)).length, legacy ? 0 : 1);
    await app.session.close(BACKGROUND_CONTEXT); release(); await execution.catch(() => {}); execution = undefined;
    app = await open(directory); app.faux.setResponses([fauxAssistantMessage("Main completed after reopen.")]);
    app.session.resume(); root = await app.session.root(BACKGROUND_CONTEXT);
    source = await app.tasks.conversation(source.id.toString());
    await publishMainNotice(app.session, source, origin, null, [], notice);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal((await notices(root)).length, 1, "A legacy queued write must not acquire a second visible projection");
    assert.equal((await root.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text === notice.text)).length, 1);
    const calls = app.faux.state.callCount;
    assert.equal(await publishMainNotice(app.session, source, origin, null, [], notice), "published");
    assert.equal((await notices(root)).length, 1);
    assert.equal(app.faux.state.callCount, calls, "Replaying publication must not start another model turn");
  } finally { release(); await execution?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("reopen completes a missing model projection without repeating the visible notice", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notice-partial-")); let app = await open(directory);
  try {
    let source = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const notice = { key: "interrupted-notice", text: "A useful result is ready.", events: [] };
    const origin = await source.commit((tx) => tx.appendEntry(source.id, { kind: "pi.assistant",
      model: [fauxAssistantMessage(notice.text)] }), BACKGROUND_CONTEXT);
    const original = app.session;
    const getRoot = original.root.bind(original), rootBeforeClose = await getRoot(BACKGROUND_CONTEXT);
    const submit = rootBeforeClose.submit.bind(rootBeforeClose);
    original.root = async () => rootBeforeClose;
    rootBeforeClose.submit = async (draft, context) => {
      const receipt = await submit(draft, context);
      if (draft.type === "write" && draft.entry.kind === "agent.user_notice") await original.close(BACKGROUND_CONTEXT);
      return receipt;
    };
    try { await assert.rejects(publishMainNotice(original, source, origin, null, [], notice), /closed|closing/i); }
    finally { original.root = getRoot; rootBeforeClose.submit = submit; }
    app = await open(directory); source = await app.tasks.conversation(source.id.toString());
    await Promise.all([publishMainNotice(app.session, source, origin, null, [], notice),
      publishMainNotice(app.session, source, origin, null, [], notice)]);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    assert.equal((await notices(root)).length, 1);
    assert.equal((await root.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text === notice.text)).length, 1);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("coordinator publication requires useful bounded text and an actual owned worker actor", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notify-user-")), app = await open(directory);
  let unbind = () => {};
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [], call: async () => ({ type: "written" }) });
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.main] }, BACKGROUND_CONTEXT);
    app.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("notify_user", { text: " " }),
        fauxToolCall("notify_user", { text: "x".repeat(4001) }),
        fauxToolCall("notify_user", { text: "Do not impersonate a task", task_id: "caller-controlled" }),
      ], { stopReason: "toolUse" }),
      (input) => { assert.equal(input.messages.filter((message) => message.role === "toolResult" && message.isError).length, 3);
        return fauxAssistantMessage(fauxToolCall("notify_user", { text: "A necessary decision has new verified evidence." }), { stopReason: "toolUse" }); },
      fauxAssistantMessage("Publication saved."),
    ]);
    assert.equal((await (await root.submit({ type: "input", content: "Report a useful update." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal((await notices(root)).length, 1);
    unbind();
    const outsider = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    unbind = app.executions.bind(outsider.id.toString(), { cwd: host.cwd, hosts: [], role: "worker", call: async () => ({ type: "written" }) });
    await outsider.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.worker] }, BACKGROUND_CONTEXT);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("notify_user", { text: "An unowned conversation cannot publish as a worker." }), { stopReason: "toolUse" }),
      (input) => { assert.ok(input.messages.some((message) => message.role === "toolResult" && message.isError &&
        message.content.some((part) => part.type === "text" && part.text.includes("No task owns this conversation"))));
        return fauxAssistantMessage("The publication was rejected."); },
    ]);
    await (await outsider.submit({ type: "input", content: "Try an invalid actor." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal((await notices(root)).length, 1);
  } finally { unbind(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
