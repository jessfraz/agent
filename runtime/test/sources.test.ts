import { fixtureModel } from "./model.js";
import { ConversationModels } from "../src/models.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { createSourceTools, SourceJournal } from "../src/sources.js";
import type { SourceBatch } from "../src/generated/SourceBatch.js";
import type { SourceEvent } from "../src/generated/SourceEvent.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";

function event(id: string, account = "alpha", version = "v1"): SourceEvent {
  return { id, version, source: { provider: "mail", account, thread_id: "thread-" + id },
    title: "Example " + id, text: "Original source content for " + id };
}
function batch(events: SourceEvent[], cursor: string, account = "alpha"): SourceBatch {
  return { source: { provider: "mail", account }, events, checkpoint: { value: cursor }, coverage: { status: "complete" } };
}
const command: Extract<RuntimeCommand, { type: "triage_sources" }> = {
  type: "triage_sources", instructions: "Be brief and act on authorized work.", model: fixtureModel, cwd: "/workspace/example", hosts: [],
};
async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database);
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  const session = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)); const executions = new Executions(); const sources = new SourceJournal(session, tasks);
  const tools = createAppTools(tasks, executions); const sourceTools = createSourceTools(sources, executions);
  registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker); registry.install(sourceTools);
  const notices: { task: string | null; text: string }[] = [];
  async function triage() {
    return sources.triage(command, (conversation) => executions.bind(conversation.id.toString(), {
      cwd: command.cwd, hosts: [], role: "triage", call: async () => ({ type: "written" }),
      notify: (task, text) => notices.push({ task, text }),
    }), [tools.host, tools.main, sourceTools]);
  }
  return { session, tasks, executions, sources, tools, sourceTools, notices, faux, triage };
}

test("source admission advances two successive checkpoints, deduplicates exact versions and isolates accounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-")); let app = await open(directory);
  try {
    const first = await app.sources.admit(batch([event("one")], "a1"), null);
    assert.equal(first.new_events, 1); assert.equal(first.checkpoint_advanced, true);
    const second = await app.sources.admit(batch([event("one")], "a2"), { value: "a1" });
    assert.equal(second.new_events, 0); assert.equal(second.checkpoint_advanced, true);
    assert.equal(second.state.checkpoint?.value, "a2");
    await app.sources.admit(batch([event("one", "beta")], "b1", "beta"), null);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal((await app.sources.states()).length, 3);
    assert.equal((await app.sources.events({ pending: true })).length, 2);
    assert.equal((await app.sources.events({ account: "alpha" })).length, 1);
    assert.notEqual((await app.sources.events({ account: "alpha" }))[0]?.key, (await app.sources.events({ account: "beta" }))[0]?.key);
    const correction = await app.sources.admit(batch([event("one", "alpha", "v2")], "a3"), { value: "a2" });
    assert.equal(correction.new_events, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("stale and incomplete reads retain new events without rolling back canonical coverage or checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-")); const app = await open(directory);
  try {
    const current = await app.sources.admit(batch([event("one")], "a1"), null);
    const stale = await app.sources.admit({ ...batch([event("two")], "stale"), coverage: { status: "more" } }, null);
    assert.equal(stale.new_events, 1); assert.equal(stale.checkpoint_advanced, false);
    assert.deepEqual(stale.state, current.state);
    const partial = await app.sources.admit({ ...batch([event("three")], "unsafe"),
      coverage: { status: "partial", message: "One source item could not be read" } }, { value: "a1" });
    assert.equal(partial.new_events, 1); assert.equal(partial.checkpoint_advanced, false);
    assert.equal(partial.state.checkpoint?.value, "a1"); assert.equal(partial.state.coverage.status, "partial");
    const unavailable = await app.sources.admit({ ...batch([], "unsafe"), coverage: { status: "unavailable", message: "Session expired" } }, { value: "a1" });
    assert.equal(unavailable.state.checkpoint?.value, "a1"); assert.equal(unavailable.state.coverage.status, "unavailable");
    assert.equal((await app.sources.events({ pending: true })).length, 3);
    await assert.rejects(app.sources.admit(batch([event("wrong", "beta")], "bad"), { value: "a1" }), /identity/);
    await assert.rejects(app.sources.admit(batch([event("new"), { ...event("one"), text: "Conflicting same version" }], "bad"), { value: "a1" }), /reused/);
    assert.equal((await app.sources.events({ query: "new" })).length, 0);
    assert.equal((await app.sources.states()).find((state) => state.source.provider === "mail")?.checkpoint?.value, "a1");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("empty source coverage gaps do not cause a model call or an all-clear notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-")); const app = await open(directory);
  try {
    await app.sources.admit({ ...batch([], "unused"), checkpoint: null, coverage: { status: "unavailable", message: "Read unavailable" } }, null);
    assert.equal(await app.sources.hasWork(), false); await app.triage();
    assert.equal(app.faux.state.callCount, 0); assert.equal(app.notices.length, 0);
    assert.equal((await app.sources.states()).find((state) => state.source.provider === "mail")?.coverage.status, "unavailable");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("new source judgments use current model settings and an invalid selection does not poison pending work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-")); const app = await open(directory);
  try {
    await app.sources.admit(batch([event("first")], "a1"), null);
    const first = await app.sources.events({ pending: true });
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dismiss_source_events", { keys: first.map((record) => record.key), reason: "Already handled" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Handled."),
    ]);
    await app.triage(); const calls = app.faux.state.callCount;
    const next = fauxProvider({ provider: "anthropic", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
    app.tasks.inference.models.setProvider(next.provider);
    await app.sources.admit(batch([event("second")], "a2"), { value: "a1" });
    const selected = { ...fixtureModel, provider: "anthropic" } satisfies import("../src/generated/ModelSelection.js").ModelSelection;
    const run = (fast: boolean) => app.sources.triage({ ...command, model: { ...selected, fast } }, (conversation, model) => app.executions.bind(conversation.id.toString(), {
      model, cwd: command.cwd, hosts: [], role: "triage", call: async () => ({ type: "written" }),
    }), [app.tools.main, app.sourceTools]);
    await assert.rejects(run(true), /Fast mode is unavailable/);
    const second = await app.sources.events({ pending: true }); assert.equal(second.length, 1);
    next.setResponses([
      fauxAssistantMessage(fauxToolCall("dismiss_source_events", { keys: second.map((record) => record.key), reason: "Handled with current settings" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Handled."),
    ]);
    await run(false);
    assert.equal(next.state.callCount, 2); assert.equal(app.faux.state.callCount, calls);
    assert.equal(await app.sources.hasWork(), false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("prose alone cannot consume source work; explicit no-action judgments remain durable and quiet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-")); const app = await open(directory);
  try {
    await app.sources.admit(batch([event("one"), event("two")], "a1"), null);
    app.faux.setResponses([fauxAssistantMessage("I looked at these messages.")]);
    await assert.rejects(app.triage(), /unaccounted/);
    assert.equal((await app.sources.events({ pending: true })).length, 2);
    const keys = (await app.sources.events({ pending: true })).map((record) => record.key);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dismiss_source_events", { keys, reason: "Routine confirmations without an unfinished request" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("No action is needed."),
    ]);
    await app.triage();
    assert.equal(await app.sources.hasWork(), false); assert.equal(app.notices.length, 0);
    const calls = app.faux.state.callCount; await app.triage(); assert.equal(app.faux.state.callCount, calls);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("actionable source decisions reach main with exact originals so a later yes has context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-")); const app = await open(directory);
  let releaseMain: (() => void) | undefined;
  try {
    await app.sources.admit(batch([event("message-one"), event("message-two")], "a1"), null);
    const keys = (await app.sources.events({ pending: true })).map((record) => record.key);
    const task = await app.tasks.create({ title: "Review possible spam", outcome: "Clean up only the approved messages" });
    const proposal = "Possible spam:\n- Example one\n- Example two\n\nClean these up?";
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("link_source_events", { keys, task_id: task.id }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("record_task", { task_id: task.id, summary: proposal,
        state: { state: "waiting", actor: "user", next_check: null } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("notify", { keys, task_id: task.id, text: proposal }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Decision recorded."),
    ]);
    await app.triage();
    assert.deepEqual(app.notices, [{ task: task.id, text: proposal }]);
    assert.equal((await app.tasks.get(task.id)).sources.length, 2);
    assert.equal((await app.tasks.get(task.id)).state.state, "waiting");
    const root = await app.session.root(BACKGROUND_CONTEXT);
    const context = await root.context(BACKGROUND_CONTEXT);
    const notices = context.messages.filter((message) => message.role === "assistant");
    assert.equal(notices.length, 1);
    const visible = notices.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
    assert.match(visible, /Clean these up/); assert.match(visible, /message-one/); assert.match(visible, /message-two/);
    assert.equal(notices.flatMap((message) => message.content).some((part) => part.type === "toolCall"), false);
    app.faux.setResponses([
      (input) => {
        assert.ok(input.messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text.includes("Clean these up?"))));
        return fauxAssistantMessage(fauxToolCall("read_source_events", { keys }), { stopReason: "toolUse" });
      },
      (input) => {
        assert.ok(input.messages.some((message) => message.role === "toolResult" && message.content.some((part) => part.type === "text" && part.text.includes("Original source content for message-one"))));
        return fauxAssistantMessage("Recovered the exact approved source messages.");
      },
    ]);
    releaseMain = app.executions.bind(root.id.toString(), { cwd: command.cwd, hosts: [], call: async () => ({ type: "written" }) });
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.sourceTools] }, BACKGROUND_CONTEXT);
    const response = await root.submit({ type: "input", content: "Yes." }, BACKGROUND_CONTEXT);
    assert.equal((await response.wait(BACKGROUND_CONTEXT)).status, "done");
  } finally { releaseMain?.(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("due task follow-ups use the same triage path and must advance their durable wait", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Await provider reply", outcome: "Resolve the supplier question" });
    await app.tasks.update(task.id, (task) => { task.state = { state: "waiting", actor: "provider", next_check: new Date(Date.now() - 1000).toISOString() }; });
    assert.equal(await app.sources.hasWork(), true);
    const next_check = new Date(Date.now() + 3_600_000).toISOString();
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { task_id: task.id, summary: "Checked the existing thread; awaiting the provider.",
        state: { state: "waiting", actor: "provider", next_check } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Next check recorded."),
    ]);
    await app.triage();
    assert.equal(await app.sources.hasWork(), false); assert.equal(app.notices.length, 0);
    await app.tasks.enqueue(task.id, "The user replied to the existing question.");
    assert.equal((await app.tasks.get(task.id)).state.state, "open");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("partial source judgment resumes its exact admitted Pi input after a process kill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-"));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/source-admission-child.js", import.meta.url)), directory],
    { stdio: ["ignore", "pipe", "pipe"] });
  let app: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const lines = createInterface({ input: child.stdout });
    assert.equal((await lines[Symbol.asyncIterator]().next()).value, "ADMITTED");
    child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("close", () => resolve())); lines.close();
    app = await open(directory);
    assert.equal((await app.sources.states()).find((state) => state.source.provider === "mail")?.checkpoint?.value, "a1");
    assert.equal((await app.sources.events()).length, 2);
    const keys = (await app.sources.events({ pending: true })).map((record) => record.key);
    assert.equal(keys.length, 1);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dismiss_source_events", { keys, reason: "Original confirmation needs no action" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Original source work accounted for."),
    ]);
    await app.triage(); assert.equal(await app.sources.hasWork(), false);
    const conversations = await app.session.commit((tx) => tx.scanConversations({}, 100), BACKGROUND_CONTEXT);
    let inputs = 0;
    for (const record of conversations.items) {
      const conversation = await app.session.conversation(record.id, BACKGROUND_CONTEXT);
      if (conversation !== undefined) inputs += (await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter((entry) => UserEntry.is(entry)).length;
    }
    assert.equal(inputs, 1);
  } finally {
    child.kill("SIGKILL"); if (app !== undefined) await app.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});
