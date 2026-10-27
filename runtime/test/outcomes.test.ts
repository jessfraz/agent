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
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { validEvent } from "../src/protocol.js";
import { TaskStore } from "../src/tasks.js";
import { createSourceTools, SourceJournal } from "../src/sources.js";
import { createAppTools, Executions } from "../src/tools.js";

const host: WorkerHost = { name: "fixture", rex_server: null, coordinator: null,
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
  registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker); registry.install(sourceTools);
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
    }), () => {}, [tools.host, tools.worker, sourceTools]);
  }
  return { session, tasks, executions, sources, tools, sourceTools, faux, prepare, run };
}

test("published task resolution and waiting outcomes preserve provenance and remain quiet after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-outcomes-")); let app = await open(directory);
  try {
    // Simulate a process disappearing after publication, before recording its receipt.
    app.sources.published = async () => {};
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
    }), [app.tools.main, app.sourceTools]);
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
    await assert.rejects(app.tasks.run(command, () => () => {}, () => {}, [], undefined,
      async () => { throw new Error("Secret-bearing auth diagnostic must not enter the outcome"); }));
    const repeated = await app.sources.events({ provider: "task_outcomes", pending: true });
    assert.equal(repeated.length, 1); assert.notEqual(repeated[0]?.key, failed[0]?.key);
    assert.doesNotMatch(repeated[0]?.event.text ?? "", /Secret-bearing/);
    let checked = false;
    await assert.rejects(app.tasks.run({ ...command, binding: { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" } },
      () => () => {}, () => {}, [], undefined, async () => { checked = true; }), /binding is not confirmed/);
    assert.equal(checked, false); assert.equal((await app.sources.events({ provider: "task_outcomes" })).length, 2);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
