import { fixtureModel } from "./model.js";
import { ConversationModels, DEFAULT_MODEL } from "../src/models.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, GenerationTask, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { validEvent } from "../src/protocol.js";
import { TaskStore } from "../src/tasks.js";
import { createSourceTools, SourceJournal } from "../src/sources.js";
import { createAppTools, Executions } from "../src/tools.js";
import { watchMainNotices } from "../src/main_observation.js";
import { isUserNotice, transcript } from "../src/transcript.js";

const host: WorkerHost = { host_id: null, name: "fixture", rex_server: null, coordinator: null,
  cwd: "/workspace/example", agent_program: "/example/agent" };
const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111",
  session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333",
  block_id: "block:44444444-4444-4444-8444-444444444444" };
const triage: Extract<RuntimeCommand, { type: "triage_sources" }> = {
  type: "triage_sources", instructions: "Finish authorized work and keep results brief.", model: fixtureModel, cwd: host.cwd, hosts: [host],
};
async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider); const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(database), { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)); const executions = new Executions(); const sources = new SourceJournal(session, tasks);
  const tools = createAppTools(tasks, executions); const sourceTools = createSourceTools(sources, executions);
  registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker); registry.install(tools.agent); registry.install(tools.legacy);
  registry.install(sourceTools.main); registry.install(sourceTools.worker);
  async function prepare(title = "Example task") {
    const task = await tasks.create({ title, model: fixtureModel, outcome: "Verify the requested outcome",
      sources: [{ provider: "mail", account: "alpha", thread_id: "example-thread" }] });
    await tasks.enqueue(task.id, "Complete the requested work.");
    await tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await tasks.get(task.id);
    if (saved.worker.state !== "bound") throw new Error("Missing task binding");
    return { type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id,
      binding, instructions: "", model: fixtureModel, cwd: host.cwd } satisfies Extract<RuntimeCommand, { type: "run_task" }>;
  }
  async function run(command: Extract<RuntimeCommand, { type: "run_task" }>) {
    return tasks.run(command, (conversation) => executions.bind(conversation.id.toString(), {
      cwd: host.cwd, hosts: [host], role: "worker", call: async () => ({ type: "written" }),
    }), [tools.host, command.agent_id === undefined ? tools.worker : tools.agent, sourceTools.worker]);
  }
  return { session, tasks, executions, sources, tools, sourceTools, faux, prepare, run };
}

test("bookkeeping finals stay internal until outcome triage selects one useful notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcome-publication-")); let app = await open(directory);
  let stop = () => {};
  const live: string[] = [];
  const observe = async () => {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    stop = await watchMainNotices(app.session, root, (event) => {
      if (event.type === "message") live.push(event.message.text);
    });
    return root;
  };
  try {
    let root = await observe();
    const command = await app.prepare("Verify a requested result");
    const bookkeeping = "Task state recorded.\n" + JSON.stringify({ tool: "record_task", task_id: command.task_id, saved: true });
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { summary: "The requested behavior passed its native check.",
        state: { state: "resolved", evidence: "The native check returned the expected result." } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(bookkeeping),
    ]);
    const result = await app.run(command);
    assert.equal(result.text, bookkeeping, "The task terminal still receives its own final answer");
    assert.deepEqual(live, [], "Internal final text must not become a main-chat update");
    assert.equal((await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.some((entry) =>
      isUserNotice(entry) || entry.kind === "agent.notice"), false);
    const conversation = await app.tasks.conversation(result.conversation_id);
    const originals = (await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
    assert.equal(originals.flatMap(transcript).filter((message) => message.role === "final" && message.text === bookkeeping).length, 1);
    assert.equal((await app.sources.events({ provider: "task_outcomes", pending: true })).length, 1);
    stop(); await app.session.close(BACKGROUND_CONTEXT); app = await open(directory); root = await observe();
    await app.run(command);
    assert.equal(app.faux.state.callCount, 0, "Reopening a completed worker must not generate or promote another final");
    assert.deepEqual(live, []);
    const pending = await app.sources.events({ provider: "task_outcomes", pending: true });
    assert.equal(pending.length, 1); assert.equal(pending[0]?.outcome?.entry_id, result.entry_id);
    assert.equal(await app.sources.hasWork(), true);
    const useful = "The requested behavior passed its native check.";
    const keys = pending.map((record) => record.key);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("link_source_events", { keys, task_id: command.task_id }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("notify", { keys, task_id: command.task_id, text: useful }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The outcome and publication are recorded."),
    ]);
    const delivered: string[] = [];
    await app.sources.triage(triage, (selected) => app.executions.bind(selected.id.toString(), {
      cwd: host.cwd, hosts: [host], role: "triage", call: async () => { throw new Error("Publication must not start a worker"); },
      notify: (_task, text) => delivered.push(text),
    }), [app.tools.main, app.sourceTools.main]);
    assert.deepEqual(delivered, [useful]); assert.deepEqual(live, [useful]);
    let notices = (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(isUserNotice);
    assert.equal(notices.length, 1); assert.deepEqual(notices.flatMap(transcript).map((message) => message.text), [useful]);
    assert.equal(await app.sources.hasWork(), false);
    stop(); await app.session.close(BACKGROUND_CONTEXT); app = await open(directory); root = await observe();
    await app.sources.triage(triage, () => { throw new Error("Handled outcomes must not restart triage"); }, []);
    assert.equal(app.faux.state.callCount, 0); assert.deepEqual(live, [useful]);
    notices = (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(isUserNotice);
    assert.equal(notices.length, 1);
    const reopened = await app.tasks.conversation(result.conversation_id);
    assert.equal((await reopened.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.flatMap(transcript)
      .filter((message) => message.role === "final" && message.text === bookkeeping).length, 1);
  } finally { stop(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("legacy published task outcomes preserve provenance and remain quiet after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); let app = await open(directory);
  try {
    for (const state of [{ state: "resolved", evidence: "Native check returned the requested result" },
      { state: "waiting", actor: "supplier", next_check: "2099-01-01T00:00:00.000Z" }]) {
      const command = await app.prepare();
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("record_task", { summary: "Verified and recorded the next step", state }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Verified and recorded the next step."),
      ]);
      await app.run(command);
      const outcomes = await app.sources.events({ provider: "task_outcomes", thread_id: command.task_id });
      assert.equal(outcomes.length, 2);
      const toolOutcome = outcomes.find((record) => record.outcome?.tool_call_id !== null); assert.ok(toolOutcome?.outcome);
      assert.ok(toolOutcome.outcome.entry_id); assert.ok(toolOutcome.outcome.tool_call_id);
      assert.equal(toolOutcome.outcome.task_id, command.task_id);
      assert.equal(toolOutcome.outcome.conversation_id, (await app.tasks.get(command.task_id)).conversation_id);
      assert.deepEqual(toolOutcome.outcome.sources, [{ provider: "mail", account: "alpha", thread_id: "example-thread" }]);
      // An older worker could stop after publication but before its receipt.
      const finalOutcome = outcomes.find((record) => record.outcome?.tool_call_id === null)?.outcome;
      assert.ok(finalOutcome?.entry_id);
      const root = await app.session.root(BACKGROUND_CONTEXT);
      await root.submit({ type: "write", requestId: "notice:" + finalOutcome.entry_id,
        entry: { kind: "agent.notice", data: { task_id: command.task_id,
          source_conversation_id: finalOutcome.conversation_id, source_entry_id: finalOutcome.entry_id },
          model: [fauxAssistantMessage("Verified and recorded the next step.")] } }, BACKGROUND_CONTEXT);
      await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
      assert.equal(await app.sources.hasWork(), false);
      assert.equal((await app.sources.events({ provider: "task_outcomes", thread_id: command.task_id })).every((record) => record.decision !== null), true);
      const count = outcomes.length;
      await app.run(command);
      assert.equal((await app.sources.events({ provider: "task_outcomes", thread_id: command.task_id })).length, count);
    }
    assert.equal(await app.sources.hasWork(), false);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    assert.equal((await root.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "assistant").length, 2);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal(await app.sources.hasWork(), false);
    await app.sources.triage(triage, () => () => {}, []);
    assert.equal(app.faux.state.callCount, 0);
    assert.equal((await app.sources.states()).find((state) => state.source.provider === "task_outcomes")?.coverage.status, "complete");
    await assert.rejects(app.sources.admit({ source: { provider: "task_outcomes", account: "local" }, events: [], checkpoint: null,
      coverage: { status: "complete" } }, null), /owned task lifecycle/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an empty final stays silent live and after reopening while preserving its due follow-up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); let app = await open(directory);
  try {
    const command = await app.prepare("Collect remote diagnostics");
    const summary = "Coordinator: collect the last day's service logs from the remote worker, then continue this task with the evidence.";
    const state = { state: "waiting", actor: "coordinator", next_check: new Date(Date.now() - 1000).toISOString() };
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { summary, state }), { stopReason: "toolUse" }),
      fauxAssistantMessage(""),
    ]);
    await app.run(command);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    assert.equal((await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter((entry) => entry.kind === "agent.notice").length, 0);
    assert.equal((await app.tasks.get(command.task_id)).summary, summary);
    assert.deepEqual((await app.tasks.get(command.task_id)).state, state);
    const outcomes = await app.sources.events({ provider: "task_outcomes", thread_id: command.task_id });
    assert.equal(outcomes.at(-1)?.outcome?.summary, summary);
    assert.equal(outcomes.find((record) => record.outcome?.tool_call_id === null)?.decision, null,
      "A quiet final still needs coordinator outcome judgment");
    assert.equal(await app.sources.hasWork(), true);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal((await app.tasks.get(command.task_id)).summary, summary);
    assert.equal(await app.sources.hasWork(), true);
    await app.run(command);
    assert.equal((await app.tasks.get(command.task_id)).summary, summary);
    const reopenedRoot = await app.session.root(BACKGROUND_CONTEXT);
    assert.equal((await reopenedRoot.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter((entry) => entry.kind === "agent.notice").length, 0);
    assert.equal(app.faux.state.callCount, 0, "Recovered history must retain the brief without another model turn");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a due coordinator handoff collects remote evidence and continues the same worker task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); const app = await open(directory);
  let release = () => {};
  try {
    const command = await app.prepare("Review fleet diagnostics");
    const summary = "Coordinator: collect the remote worker's service log for the last day, then continue this task with the evidence.";
    const state = { state: "waiting", actor: "coordinator", next_check: new Date(Date.now() - 1000).toISOString() };
    let recorded = () => {};
    const ready = new Promise<void>((resolve) => { recorded = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { summary, state }), { stopReason: "toolUse" }),
      async () => { recorded(); await gate; return fauxAssistantMessage(summary); },
    ]);
    const running = app.run(command); await ready;
    assert.equal(await app.sources.hasWork(), false, "A busy worker retains ownership of its due handoff");
    release(); await running;
    const before = await app.tasks.get(command.task_id);
    const handoff = await app.sources.events({ provider: "task_outcomes", pending: true });
    assert.equal(handoff.length, 1);
    assert.equal(await app.sources.hasWork(), true, "The durable handoff remains pending for coordinator judgment");
    const root = await app.session.root(BACKGROUND_CONTEXT);
    assert.equal((await root.context(BACKGROUND_CONTEXT)).messages.some((message) => message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text === summary)), false);
    const remote: WorkerHost = { ...host, host_id: "55555555-5555-4555-8555-555555555555", name: "remote-fixture" };
    const evidence = "Remote service log: one startup failure, followed by successful recovery.";
    const followUp = "Continue the existing review with coordinator-collected evidence: " + evidence;
    const calls: HostCommand[] = [];
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("link_source_events", { keys: handoff.map((record) => record.key), task_id: command.task_id }), { stopReason: "toolUse" }),
      (input) => {
        assert.ok(input.messages.some((message) => message.role === "user" && (typeof message.content === "string"
          ? message.content.includes('"due_followups"') && message.content.includes(summary)
          : message.content.some((part) => part.type === "text" && part.text.includes('"due_followups"') && part.text.includes(summary)))));
        return fauxAssistantMessage(fauxToolCall("exec", { host: remote.name, program: "journalctl",
          args: ["--user", "--unit=fixture-agent.service", "--since=1 day ago", "--no-pager"], timeout_seconds: 30 }), { stopReason: "toolUse" });
      },
      (input) => {
        assert.ok(input.messages.some((message) => message.role === "toolResult" &&
          message.content.some((part) => part.type === "text" && part.text.includes(evidence))));
        return fauxAssistantMessage(fauxToolCall("delegate_task", { task_id: command.task_id,
          input: followUp, mode: "follow_up" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Evidence delivered to the existing review task."),
    ]);
    await app.sources.triage({ ...triage, hosts: [host, remote] }, (conversation) => app.executions.bind(conversation.id.toString(), {
      cwd: host.cwd, hosts: [host, remote], role: "triage", call: async (operation) => {
        calls.push(operation);
        if (operation.type === "on_node") {
          assert.equal(operation.host_id, remote.host_id);
          assert.deepEqual(operation.command, { type: "exec", program: "journalctl",
            args: ["--user", "--unit=fixture-agent.service", "--since=1 day ago", "--no-pager"], cwd: remote.cwd, timeout_seconds: 30 });
          return { type: "process", exit_code: 0, stdout: evidence, stderr: "", truncated: false };
        }
        assert.equal(operation.type, "resume_worker");
        if (operation.type !== "resume_worker") throw new Error("The existing task worker must be resumed");
        assert.equal(operation.task_id, command.task_id); assert.deepEqual(operation.binding, binding);
        return { type: "written" };
      },
    }), [app.tools.host, app.tools.main, app.sourceTools.main]);
    const continued = await app.tasks.get(command.task_id);
    assert.deepEqual(calls.map((operation) => operation.type), ["on_node", "resume_worker"]);
    assert.equal((await app.tasks.list()).length, 1);
    assert.equal(continued.conversation_id, before.conversation_id);
    assert.deepEqual(continued.worker, before.worker);
    assert.equal(continued.state.state, "open");
    assert.deepEqual(continued.pending.map((input) => ({ content: input.content, mode: input.mode })), [{ content: followUp, mode: "follow_up" }]);
    assert.equal(await app.sources.hasWork(), false);
    app.faux.setResponses([
      (input) => {
        assert.ok(input.messages.some((message) => message.role === "user" && (typeof message.content === "string"
          ? message.content === followUp : message.content.some((part) => part.type === "text" && part.text === followUp))));
        return fauxAssistantMessage(fauxToolCall("record_task", { summary: "Checked the returned evidence.",
          state: { state: "resolved", evidence: "The coordinator's bounded remote logs confirm recovery." } }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Review complete: the remote startup failure recovered."),
    ]);
    await app.run(command);
    const finished = await app.tasks.get(command.task_id);
    assert.equal(finished.conversation_id, before.conversation_id);
    assert.deepEqual(finished.worker, before.worker);
    assert.equal(finished.state.state, "resolved"); assert.equal(finished.pending.length, 0);
    assert.equal(finished.summary, "Review complete: the remote startup failure recovered.");
    const completed = await app.sources.events({ provider: "task_outcomes", pending: true });
    assert.equal(completed.length, 1);
    await app.sources.decide(completed.map((record) => record.key), { type: "task", task_id: command.task_id });
    assert.equal(await app.sources.hasWork(), false);
  } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("active progress defers source triage and linking the finished event does not reopen or requeue its task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); const app = await open(directory);
  let release: () => void = () => {};
  try {
    const command = await app.prepare(); let recorded: () => void = () => {};
    const ready = new Promise<void>((resolve) => { recorded = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { summary: "Still requires a verified result", state: { state: "open" } }), { stopReason: "toolUse" }),
      async () => { recorded(); await gate; return fauxAssistantMessage("A concrete follow-up remains."); },
    ]);
    const running = app.run(command); await ready;
    assert.equal((await app.sources.events({ provider: "task_outcomes", pending: true })).length, 1);
    assert.equal(await app.sources.hasWork(), false);
    release(); await running;
    assert.equal(await app.sources.hasWork(), true);
    const pending = await app.sources.events({ provider: "task_outcomes", pending: true }); assert.equal(pending.length, 1);
    const current = await app.tasks.get(command.task_id); const first = pending[0]; assert.ok(first);
    assert.deepEqual((await app.tasks.search("", [first.event.source])).map((task) => task.id), [command.task_id]);
    await app.tasks.update(command.task_id, (task) => { task.state = { state: "resolved", evidence: "Verified by the user" }; });
    await app.sources.decide(pending.map((record) => record.key), { type: "task", task_id: command.task_id });
    const linked = await app.tasks.get(command.task_id);
    assert.equal(linked.state.state, "resolved"); assert.deepEqual(linked.pending, current.pending);
    assert.deepEqual(linked.sources, current.sources);
    assert.equal(await app.sources.hasWork(), false);
  } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("parent workers can read agents and record progress without being offered child-only result reporting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); const app = await open(directory);
  try {
    const command = await app.prepare("Continue parent work"); let offered: string[] = [];
    app.faux.setResponses([
      (input) => {
        offered = getCurrentTools(input.messages).map((tool) => tool.name);
        return fauxAssistantMessage(fauxToolCall("read_agents", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("record_task", { summary: "The parent checked its agents and retained the next step.",
        state: { state: "open" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The parent checked its agents and retained the next step."),
    ]);
    await app.run(command);
    assert.equal(offered.includes("read_agents"), true);
    assert.equal(offered.includes("report_result"), false, "Only a child assignment can report an agent result");
    assert.equal((await app.tasks.get(command.task_id)).summary, "The parent checked its agents and retained the next step.");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("workers are offered source reads without coordinator decisions and stale source calls remain guarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); const app = await open(directory);
  try {
    await app.sources.admit({ source: { provider: "mail", account: "alpha" }, checkpoint: null, coverage: { status: "complete" },
      events: [{ id: "original", version: "v1", source: { provider: "mail", account: "alpha", thread_id: "original-thread" },
        title: "Original evidence", text: "Keep this exact source available to its worker." }] }, null);
    const original = (await app.sources.events({ provider: "mail", pending: true }))[0]; assert.ok(original);
    const command = await app.prepare("Inspect source evidence");
    let offered: string[] = [];
    app.faux.setResponses([
      (input) => {
        offered = getCurrentTools(input.messages).map((tool) => tool.name);
        return fauxAssistantMessage(fauxToolCall("read_source_events", { keys: [original.key] }), { stopReason: "toolUse" });
      },
      (input) => {
        assert.ok(input.messages.some((message) => message.role === "toolResult" &&
          message.content.some((part) => part.type === "text" && part.text.includes(original.event.text) && part.text.includes(original.key))));
        return fauxAssistantMessage("The original source is available for this task.");
      },
    ]);
    await app.run(command);
    assert.ok(offered.includes("read_source_events"));
    assert.deepEqual(offered.filter((name) => ["link_source_events", "dismiss_source_events", "notify"].includes(name)), []);
    assert.equal((await app.sources.events({ keys: [original.key] }))[0]?.decision, null);
    // An older saved worker can still name the coordinator extension.
    // Its tool definitions must retain their execution guards.
    await app.tasks.enqueue(command.task_id, "Continue using an older saved tool selection.");
    app.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("link_source_events", { keys: [original.key], task_id: command.task_id }),
        fauxToolCall("dismiss_source_events", { keys: [original.key], reason: "A worker must not decide this" }),
        fauxToolCall("notify", { keys: [original.key], task_id: command.task_id, text: "A worker must not publish this" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("The source decisions still belong to the coordinator."),
    ]);
    let notices = 0;
    await app.tasks.run(command, (conversation) => app.executions.bind(conversation.id.toString(), {
      cwd: host.cwd, hosts: [host], role: "worker", call: async () => ({ type: "written" }), notify: () => { notices += 1; },
    }), [app.tools.host, app.tools.worker, app.sourceTools.main]);
    const conversation = await app.tasks.conversation((await app.tasks.get(command.task_id)).conversation_id);
    const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const denied = entries.items.flatMap((entry) => entry.model?.flatMap((message) => message.role === "toolResult" &&
      ["link_source_events", "dismiss_source_events", "notify"].includes(message.toolName) ? [message] : []) ?? []);
    assert.equal(denied.length, 3); assert.ok(denied.every((message) => message.isError));
    assert.ok(denied.every((message) => message.content.some((part) => part.type === "text" && part.text.includes("Source decisions belong to the coordinator"))));
    assert.equal(notices, 0);
    assert.equal((await app.sources.events({ keys: [original.key] }))[0]?.decision, null);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("coordinator follow-through consumes an incomplete outcome without generating another source loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); const app = await open(directory);
  try {
    const command = await app.prepare(); app.faux.setResponses([fauxAssistantMessage("The supplier still owes a response.")]);
    await app.run(command);
    const pending = await app.sources.events({ provider: "task_outcomes", pending: true }); assert.equal(pending.length, 1);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("link_source_events", { keys: pending.map((record) => record.key), task_id: command.task_id }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("record_task", { task_id: command.task_id, summary: "Waiting for the supplier's reply",
        state: { state: "waiting", actor: "supplier", next_check: "2099-01-01T00:00:00.000Z" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Follow-up is recorded."),
    ]);
    await app.sources.triage(triage, (conversation) => app.executions.bind(conversation.id.toString(), {
      cwd: host.cwd, hosts: [host], role: "triage", call: async () => { throw new Error("No duplicate worker should be spawned"); },
    }), [app.tools.main, app.sourceTools.main]);
    assert.equal(await app.sources.hasWork(), false);
    const calls = app.faux.state.callCount;
    await app.sources.triage(triage, () => () => {}, []);
    assert.equal(app.faux.state.callCount, calls);
    assert.equal((await app.tasks.get(command.task_id)).pending.length, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("task state and outcome admission roll back together when the durable journal rejects a write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); const app = await open(directory);
  try {
    const command = await app.prepare();
    const record = app.sources.recordIn.bind(app.sources);
    app.sources.recordIn = async (tx, outcome, settled, attempt) => {
      await record(tx, outcome, settled, attempt);
      if (outcome.tool_call_id !== null) throw new Error("Reject this commit after event admission");
    };
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { summary: "This mutation must roll back",
        state: { state: "resolved", evidence: "Must not escape its transaction" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The requested resolution was not committed."),
    ]);
    await app.run(command);
    assert.equal((await app.tasks.get(command.task_id)).state.state, "open");
    const outcomes = await app.sources.events({ provider: "task_outcomes" });
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0]?.outcome?.state.state, "progress");
    assert.equal(outcomes[0]?.outcome?.tool_call_id, null);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("child outcomes retain tool provenance and settle atomically with delivery to their parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); const app = await open(directory);
  try {
    const command = await app.prepare();
    const child = await app.tasks.createAgent(command.task_id, { id: "fixture-review", title: "Review",
      outcome: "Review the concrete change", input: "Check the change", inputId: "fixture-child-input" });
    const childBinding = { ...binding, block_id: "block:66666666-6666-4666-8666-666666666666" };
    await app.tasks.dispatchAgent(command.task_id, child.id, async () => ({ type: "spawned", binding: childBinding }));
    const task = await app.tasks.get(command.task_id); const agent = task.agents[0]; assert.ok(agent);
    if (agent.worker.state !== "bound") throw new Error("Missing child binding");
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("report_result", { summary: "Review found a concrete follow-up", failure: "The behavior check failed" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Review complete; the parent has the result."),
    ]);
    await app.run({ ...command, agent_id: child.id, allocation_id: agent.worker.allocation_id, binding: childBinding });
    const outcomes = await app.sources.events({ provider: "task_outcomes" });
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes.every((record) => record.outcome?.conversation_id === child.conversation_id), true);
    assert.equal(outcomes.some((record) => record.outcome?.tool_call_id !== null && record.outcome?.entry_id !== null), true);
    assert.equal(outcomes.every((record) => record.decision !== null), true);
    const saved = await app.tasks.get(command.task_id);
    assert.equal(saved.state.state, "open"); assert.equal(saved.agents[0]?.state.state, "failed");
    assert.equal(saved.pending.some((input) => input.id.startsWith("agent-result:")), true);
    assert.equal(await app.sources.hasWork(), false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a successful native child final completes its assignment without a reporting tool call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-child-final-")); const app = await open(directory);
  try {
    const command = await childCommand(app);
    const answer = "The bounded source review is complete; the original evidence supports the result.";
    app.faux.setResponses([fauxAssistantMessage(answer)]);
    const result = await app.run(command);
    const saved = await app.tasks.get(command.task_id); const child = saved.agents[0]; assert.ok(child);
    assert.equal(child.state.state, "done"); assert.equal(child.summary, answer); assert.equal(saved.state.state, "open");
    assert.ok(saved.pending.some((input) => input.id.startsWith("agent-result:") && input.content.includes(answer)));
    const outcomes = await app.sources.events({ provider: "task_outcomes" });
    assert.ok(outcomes.some((record) => record.outcome?.conversation_id === child.conversation_id && record.outcome.entry_id === result.entry_id && record.outcome.tool_call_id === null));
    const delivered = saved.pending.filter((input) => input.id.startsWith("agent-result:"));
    await app.run(command);
    assert.deepEqual((await app.tasks.get(command.task_id)).pending.filter((input) => input.id.startsWith("agent-result:")), delivered);
    assert.equal(app.faux.state.callCount, 1, "Publishing an already completed result must not repeat source/model work");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a continuation admitted at the child completion boundary keeps its own final result", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-child-completion-race-")); const app = await open(directory);
  const commit = app.session.commit.bind(app.session);
  let release = () => {}, running: Promise<unknown> | undefined;
  try {
    const command = await childCommand(app);
    let reached = () => {}; const checked = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; }); let first = true;
    // Stop after the real native receipt transaction releases its line. A
    // continuation can commit here without replacing the model or task store.
    app.session.commit = async (change, context) => {
      let inspected = false;
      const result = await commit(async (tx) => {
        const scan = tx.scanTasks.bind(tx);
        tx.scanTasks = async (query, limit, cursor) => {
          const page = await scan(query, limit, cursor);
          if (query.kind === GenerationTask.definition.name) inspected = true;
          return page;
        };
        return change(tx);
      }, context);
      if (inspected && first) { first = false; reached(); await gate; }
      return result;
    };
    const firstAnswer = "The first bounded assignment is complete.", secondAnswer = "The second assignment has a different verified result.";
    app.faux.setResponses([fauxAssistantMessage(firstAnswer), fauxAssistantMessage(secondAnswer)]);
    running = app.run(command); await checked;
    await app.tasks.continueAgent(command.task_id, command.agent_id, "Review the second assignment.", "second-child-assignment");
    release(); await running; running = undefined;
    const saved = await app.tasks.get(command.task_id); const child = saved.agents[0]; assert.ok(child);
    assert.equal(child.state.state, "done"); assert.equal(child.summary, secondAnswer); assert.equal(child.pending.length, 0);
    assert.equal(saved.state.state, "open"); assert.equal(app.faux.state.callCount, 2);
    const delivered = saved.pending.filter((input) => input.id.startsWith("agent-result:"));
    assert.ok(delivered.at(-1)?.content.includes(secondAnswer));
    const conversation = await app.tasks.conversation(child.conversation_id);
    const receipt = await app.session.commit((tx) => tx.submissionByRequest(conversation.id, "second-child-assignment"), BACKGROUND_CONTEXT);
    assert.ok(receipt?.type === "input" && receipt.status === "done");
    const outcomes = await app.sources.events({ provider: "task_outcomes" });
    assert.ok(outcomes.some((record) => record.outcome?.entry_id === receipt.answer.toString() && record.outcome.summary === secondAnswer));
  } finally { release(); await running; app.session.commit = commit; await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("empty, failed and aborted native child answers remain failures", async (t) => {
  for (const stopReason of ["stop", "error", "aborted"]) await t.test(stopReason, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-child-no-answer-")); const app = await open(directory);
    try {
      const command = await childCommand(app);
      const response = stopReason === "error" ? fauxAssistantMessage("Partial evidence", { stopReason: "error", errorMessage: "Synthetic native failure" })
        : stopReason === "aborted" ? fauxAssistantMessage("Partial evidence", { stopReason: "aborted" }) : fauxAssistantMessage("");
      app.faux.setResponses([response]);
      if (stopReason === "stop") await app.run(command); else await assert.rejects(app.run(command));
      const saved = await app.tasks.get(command.task_id);
      assert.equal(saved.state.state, "open"); assert.equal(saved.agents[0]?.state.state, "failed");
      if (saved.agents[0]?.state.state === "failed") assert.match(saved.agents[0].state.reason,
        stopReason === "stop" ? /without a successful final answer/ : /execution did not complete/);
    } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
  });
});

test("reopening after a native child final uses its durable receipt and rejects a newer unanswered generation", { timeout: 15_000 }, async (t) => {
  for (const newerFailure of [false, true]) await t.test(newerFailure ? "newer native failure" : "completed final", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-child-recovery-")); let app = await open(directory);
    const controller = new AbortController(); let resume = () => {}, releaseExecution = () => {};
    let running: Promise<unknown> | undefined;
    try {
      const command = await childCommand(app), answer = "The native bounded review finished before parent delivery.";
      let pause = () => {}; const paused = new Promise<void>((resolve) => { pause = resolve; });
      const gate = new Promise<void>((resolve) => { resume = resolve; }); let boundaries = 0;
      app.faux.setResponses([fauxAssistantMessage(answer)]);
      running = app.tasks.run(command, (conversation) => {
        releaseExecution = app.executions.bind(conversation.id.toString(), { cwd: host.cwd, hosts: [host], role: "worker", call: async () => ({ type: "written" }) });
        return releaseExecution;
      }, [app.tools.agent], undefined, undefined, {
        signal: controller.signal, async ready() {}, answer() {}, idle() {},
        async beforeTurn() { if (++boundaries === 3) { pause(); await gate; } },
      }).catch((error: unknown) => error);
      await paused;
      const before = await app.tasks.get(command.task_id); const child = before.agents[0]; assert.ok(child);
      assert.equal(child.state.state, "open"); assert.equal(child.pending.length, 0);
      assert.equal(before.pending.some((input) => input.id.startsWith("agent-result:")), false);
      const conversation = await app.tasks.conversation(child.conversation_id);
      const native = await app.session.commit((tx) => tx.submissionByRequest(conversation.id, "child-assignment"), BACKGROUND_CONTEXT);
      assert.ok(native?.type === "input" && native.status === "done");
      await app.session.close(BACKGROUND_CONTEXT); controller.abort(); resume(); await running; running = undefined; releaseExecution();
      app = await open(directory);
      if (newerFailure) {
        const reopened = await app.tasks.conversation(child.conversation_id);
        await reopened.configure({ model: { provider: "unavailable-fixture", modelId: "missing" } }, BACKGROUND_CONTEXT);
        const failed = await (await reopened.submit({ type: "input", content: "A newer assignment has no usable model.", requestId: "newer-unanswered" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
        assert.ok(failed.type === "input" && failed.status === "unanswered");
        await app.tasks.inference.configure(reopened, fixtureModel, {});
        await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
      }
      const result = await app.run(command);
      const saved = await app.tasks.get(command.task_id); const completed = saved.agents[0]; assert.ok(completed);
      assert.equal(completed.state.state, newerFailure ? "failed" : "done"); assert.equal(saved.state.state, "open");
      assert.equal(app.faux.state.callCount, 0, "Recovery must publish stored evidence without another model/source read");
      if (!newerFailure) {
        assert.equal(completed.summary, answer); assert.equal(result.entry_id, native.answer.toString());
        const delivered = saved.pending.filter((input) => input.id.startsWith("agent-result:")); assert.equal(delivered.length, 1);
        await app.run(command);
        assert.deepEqual((await app.tasks.get(command.task_id)).pending.filter((input) => input.id.startsWith("agent-result:")), delivered);
      }
    } finally { controller.abort(); resume(); await running; releaseExecution(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
  });
});

async function childCommand(app: Awaited<ReturnType<typeof open>>) {
  const command = await app.prepare();
  const child = await app.tasks.createAgent(command.task_id, { id: "bounded-review", title: "Review", outcome: "Review the original evidence",
    input: "Complete the bounded review", inputId: "child-assignment" });
  const childBinding = { ...binding, block_id: "block:66666666-6666-4666-8666-666666666666" };
  await app.tasks.dispatchAgent(command.task_id, child.id, async () => ({ type: "spawned", binding: childBinding }));
  const saved = (await app.tasks.get(command.task_id)).agents[0]; assert.ok(saved?.worker.state === "bound");
  return { ...command, agent_id: child.id, allocation_id: saved.worker.allocation_id, binding: childBinding };
}

test("the real bridge admits a safe failed outcome when authentication fails before a model turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); let app = await open(directory);
  try {
    const command = await app.prepare();
    await app.tasks.update(command.task_id, (task) => { task.model = DEFAULT_MODEL; });
    command.model = DEFAULT_MODEL;
    await app.session.close(BACKGROUND_CONTEXT);
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
    let output = ""; let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify({ version: 1, id: 1, command }) + "\n");
    assert.equal(await exited, 0, errors);
    const events = output.trim().split("\n").map((line): RuntimeEvent => { const event: unknown = JSON.parse(line); assert.ok(validEvent(event)); return event; });
    assert.equal(events.filter((event) => event.event.type === "failure").length, 1);
    app = await open(directory);
    assert.equal((await app.tasks.get(command.task_id)).pending.length, 1);
    const failed = await app.sources.events({ provider: "task_outcomes", pending: true }); assert.equal(failed.length, 1);
    assert.equal(failed[0]?.outcome?.state.state, "failed"); assert.equal(failed[0]?.outcome?.entry_id, null);
    assert.equal(await app.sources.hasWork(), true);
    await app.tasks.update(command.task_id, (task) => { task.model = fixtureModel; });
    await assert.rejects(app.tasks.run(command, () => () => {}, [], undefined,
      async () => { throw new Error("Secret-bearing auth diagnostic must not enter the outcome"); }));
    const repeated = await app.sources.events({ provider: "task_outcomes", pending: true });
    assert.equal(repeated.length, 1); assert.notEqual(repeated[0]?.key, failed[0]?.key);
    assert.doesNotMatch(repeated[0]?.event.text ?? "", /Secret-bearing/);
    let checked = false;
    await assert.rejects(app.tasks.run({ ...command, binding: { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" } },
      () => () => {}, [], undefined, async () => { checked = true; }), /binding is not confirmed/);
    assert.equal(checked, false); assert.equal((await app.sources.events({ provider: "task_outcomes" })).length, 2);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
