import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry, defineEntry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { HistoryStore } from "../src/history.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { transcript } from "../src/transcript.js";
import type { DelegationDecision } from "../src/generated/DelegationDecision.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { SearchResult } from "../src/search.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { fixtureModel } from "./model.js";

const Decision = defineEntry<DelegationDecision>("agent.delegation");
const host: WorkerHost = { host_id: null, name: "fixture", rex_server: null, coordinator: null, cwd: "/example/project", agent_program: "/example/agent" };
const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
const tool = (args: Parameters<typeof fauxToolCall>[1], id: string) => fauxAssistantMessage(fauxToolCall("delegate_task", args, { id }), { stopReason: "toolUse" });
async function open(directory: string) {
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)), imported = new HistoryStore(session); tasks.useHistory(imported);
  const executions = new Executions(), tools = createAppTools(tasks, executions); registry.install(tools.main);
  const root = await session.root(BACKGROUND_CONTEXT), effects: HostCommand[] = [];
  let found: SearchResult = { candidates: [], gaps: [] };
  const release = executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], model: fixtureModel,
    search: async () => found, async call(command) {
      effects.push(command);
      if (command.type === "spawn_worker") return { type: "spawned", binding: { ...binding, session_id: `session:${randomUUID()}` } };
      assert.equal(command.type, "resume_worker"); return { type: "written" };
    } });
  await tasks.inference.configure(root, fixtureModel, { extensions: [tools.main] });
  async function turn(steps: FauxResponseStep[]) {
    faux.setResponses(steps);
    assert.equal((await (await root.submit({ type: "input", content: "Refine the same cleanup effort." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(faux.getPendingResponseCount(), 0);
  }
  async function decisions() { return (await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.filter(Decision.is); }
  return { session, tasks, imported, root, faux, effects, turn, decisions, related(result: SearchResult) { found = result; },
    async close() { release(); await session.close(BACKGROUND_CONTEXT); } };
}

test("forced new delegation requires a separate-outcome reason when related work exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-delegation-")); let app = await open(directory);
  try {
    const old = await app.tasks.create({ title: "Organize device playbooks", outcome: "Finish the broader cleanup", model: fixtureModel });
    app.related({ candidates: [{ conversation_id: old.conversation_id, score: 0.91, matches: [{ entry_id: "old-evidence", text: "The same cleanup effort", source_refs: [] }] }],
      gaps: ["Synthetic import indexing is incomplete"] });
    await app.turn([tool({ title: "Retire obsolete orchestration", outcome: "Clean up more", input: "Continue cleanup", new_task: true }, "forced-without-reason"),
      fauxAssistantMessage("The existing cleanup remains available for continuation.")]);
    assert.equal(app.effects.length, 0, "Related work must not be bypassed into a new allocation without a separate-outcome reason");
    assert.deepEqual((await app.tasks.list()).map((task) => task.id), [old.id]);
    const [entry] = await app.decisions(); assert.ok(entry);
    assert.equal(entry.data.actor_conversation_id, app.root.id.toString()); assert.equal(entry.data.tool_call_id, "forced-without-reason");
    assert.equal(entry.data.query, "Continue cleanup Retire obsolete orchestration");
    assert.deepEqual(entry.data.selection, { kind: "considered" });
    assert.deepEqual(entry.data.candidates.map(({ conversation_id, task_id }) => ({ conversation_id, task_id })),
      [{ conversation_id: old.conversation_id, task_id: old.id }]);
    assert.ok(entry.data.candidates.every((candidate) => Number.isFinite(candidate.score) && candidate.score > 0));
    assert.deepEqual(entry.data.gaps, ["Synthetic import indexing is incomplete"]);
    assert.equal(entry.model, undefined); assert.deepEqual(transcript(entry), []);
    const indexed = []; for await (const record of app.tasks.records(app.root.id.toString())) indexed.push(record.entry_id);
    assert.equal(indexed.includes(entry.id.toString()), false, "Private decision metadata must not become search text");
    assert.equal(app.faux.state.callCount, 2);
    const decision = entry.data;
    await app.close(); app = await open(directory);
    const { recordDelegation } = await import("../src/delegation.js");
    await Promise.all([0, 1].map(() => app.session.commit((tx) => recordDelegation(tx, app.root.id, decision), BACKGROUND_CONTEXT)));
    assert.deepEqual((await app.decisions()).map((entry) => entry.data), [decision], "Reopen and replay must not duplicate decision receipts");
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("same-effort continuation reuses its binding while a justified separate outcome retains its candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-delegation-")); const app = await open(directory);
  try {
    const old = await app.tasks.create({ title: "Organize device playbooks", outcome: "Finish the broader cleanup", model: fixtureModel });
    await app.tasks.dispatch(old.id, host, async () => ({ type: "spawned", binding }));
    app.related({ candidates: [{ conversation_id: old.conversation_id, score: 0.91, matches: [{ entry_id: "old-evidence", text: "Existing cleanup", source_refs: [] }] }], gaps: [] });
    await app.turn([tool({ title: "Further playbook cleanup", outcome: "Refine the cleanup", input: "Clean up more" }, "consider-existing"),
      tool({ task_id: old.id, input: "Continue the same broader cleanup; use child terminals for subwork." }, "reuse-existing"),
      tool({ title: "Independent calendar repair", outcome: "Repair calendar sync", input: "Repair calendar sync", new_task: true,
        new_task_reason: "Calendar synchronization is a separate outcome from device playbook cleanup." }, "separate-calendar"), fauxAssistantMessage("Cleanup continued and the separate calendar repair started.")]);
    assert.deepEqual(app.effects.map((command) => command.type), ["resume_worker", "spawn_worker"]);
    assert.equal((await app.tasks.list()).length, 2);
    const continued = await app.tasks.get(old.id); assert.ok(continued.worker.state === "bound");
    assert.deepEqual(continued.worker.binding, binding); assert.equal(continued.conversation_id, old.conversation_id);
    const entries = await app.decisions(); assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => entry.data.selection.kind), ["considered", "reuse", "create"]);
    assert.deepEqual(entries[1]?.data.selection, { kind: "reuse", task_id: old.id, conversation_id: old.conversation_id });
    assert.equal(entries[1]?.data.query, null); assert.deepEqual(entries[1]?.data.candidates, []);
    const created = entries[2]?.data; assert.ok(created?.selection.kind === "create");
    assert.equal(created.selection.reason, "Calendar synchronization is a separate outcome from device playbook cleanup.");
    assert.notEqual(created.selection.task_id, old.id);
    assert.deepEqual(created.candidates.map(({ conversation_id, task_id }) => ({ conversation_id, task_id })),
      entries[0]?.data.candidates.map(({ conversation_id, task_id }) => ({ conversation_id, task_id })));
    assert.ok(created.candidates.every((candidate) => Number.isFinite(candidate.score) && candidate.score > 0));
    const separate = await app.tasks.get(created.selection.task_id); assert.ok(separate.worker.state === "bound");
    assert.notEqual(separate.worker.binding.session_id, binding.session_id);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("adoption and later continuation record the same imported conversation without creating another task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-delegation-adopt-")); const app = await open(directory);
  try {
    const saved = await app.imported.import({ host_id: "synthetic-source", thread: { id: "old-thread", title: "Unresolved component quote", cwd: "/old/project",
      created_at: 1, updated_at: 2, forked_from_id: null, parent_thread_id: null, version: "v1", version_reliable: true, archived: true },
      items: [{ id: "old-item", turn_id: "old-turn", kind: "userMessage", role: "user", text: "The violet component quote remains open.", version: "v1",
        order: 0, timestamp_ms: 1, data: { text: "The violet component quote remains open." }, assets: [] }], next_cursor: null, gaps: [], complete: true });
    app.related({ candidates: [{ conversation_id: saved.conversation.conversation_id, score: 0.8,
      matches: [{ entry_id: saved.entry_ids[0]!, text: "The violet component quote remains open.", source_refs: [] }] }], gaps: [] });
    await app.turn([tool({ conversation_id: saved.conversation.conversation_id, input: "Resolve the retained quote." }, "adopt-quote"),
      tool({ conversation_id: saved.conversation.conversation_id, input: "Continue that same quote." }, "continue-quote"), fauxAssistantMessage("The historical quote is the active task.")]);
    const [task] = await app.tasks.list(); assert.ok(task); assert.equal((await app.tasks.list()).length, 1);
    assert.equal(task.conversation_id, saved.conversation.conversation_id);
    assert.deepEqual(app.effects.map((command) => command.type), ["spawn_worker", "resume_worker"]);
    assert.deepEqual((await app.decisions()).map((entry) => entry.data.selection), [
      { kind: "adopt", task_id: task.id, conversation_id: task.conversation_id }, { kind: "reuse", task_id: task.id, conversation_id: task.conversation_id },
    ]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
