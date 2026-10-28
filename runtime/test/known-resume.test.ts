import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineEntry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { AllocationDecision } from "../src/generated/AllocationDecision.js";
import { transcript } from "../src/transcript.js";
import { fixtureModel } from "./model.js";

const host = { host_id: "11111111-1111-4111-8111-111111111111", name: "fixture", rex_server: null, coordinator: null,
  cwd: "/workspace/example", agent_program: "/fixture/agent" };
const binding = { host_id: host.host_id, session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
const Decision = defineEntry<AllocationDecision>("agent.allocation");
async function open(directory: string) {
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  return { session, tasks: new TaskStore(session, new ConversationModels(models)), faux };
}

test("failed resumption preserves the known binding and cannot revoke it into a duplicate folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-known-resume-")); const app = await open(directory);
  let spawns = 0, resumes = 0;
  try {
    const task = await app.tasks.create({ title: "Continue existing work", outcome: "Finish the original task", model: fixtureModel });
    await app.tasks.enqueue(task.id, "Retain the original pending instruction", "original-input");
    await app.tasks.dispatch(task.id, host, async (): Promise<HostResult> => { spawns += 1; return { type: "spawned", binding }; });
    const original = await app.tasks.get(task.id); assert.ok(original.worker.state === "bound");
    let failed = false;
    try {
      await app.tasks.dispatch(task.id, host, async (command): Promise<HostResult> => {
        if (command.type === "resume_worker") { resumes += 1; return { type: "failed", message: "Synthetic Rex read failed before mutation" }; }
        assert.equal(command.type, "on_node"); return { type: "failed", message: "Synthetic inspection unavailable" };
      });
    } catch { failed = true; }
    assert.deepEqual((await app.tasks.get(task.id)).worker, original.worker,
      "A failed known-session resume must retain the complete reusable binding");
    assert.equal(failed, true, "A retained binding must not pretend its failed resume succeeded");
    await assert.rejects(app.tasks.revokeAllocation(task.id, original.worker.allocation_id));
    const resumed = await app.tasks.dispatch(task.id, host, async (command): Promise<HostResult> => {
      assert.equal(command.type, "resume_worker"); resumes += 1; return { type: "written" };
    });
    assert.deepEqual(resumed.worker, original.worker); assert.deepEqual(resumed.pending, original.pending);
    assert.equal(resumed.conversation_id, original.conversation_id); assert.equal(spawns, 1); assert.equal(resumes, 2);
    assert.equal(app.faux.state.callCount, 0);
    const conversation = await app.tasks.conversation(task.conversation_id);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const receipts = entries.items.filter(Decision.is);
    assert.deepEqual(receipts.map((entry) => [entry.data.operation, entry.data.previous.state, entry.data.current.state, entry.data.result.type]), [
      ["create", "unassigned", "allocating", "pending"], ["create", "allocating", "bound", "spawned"],
      ["resume", "bound", "resuming", "pending"], ["resume", "resuming", "bound", "failed"],
      ["revoke", "bound", "bound", "rejected"], ["resume", "bound", "resuming", "pending"], ["resume", "resuming", "bound", "written"],
    ]);
    assert.ok(receipts.every((entry) => entry.model === undefined && transcript(entry).length === 0));
    const indexed = []; for await (const record of app.tasks.records(task.conversation_id)) indexed.push(record.entry_id);
    assert.equal(indexed.some((id) => receipts.some((entry) => entry.id.toString() === id)), false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an in-flight known resume cannot be reset and survives coordinator reopen before the native reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resume-restart-")); let app = await open(directory);
  let release = () => {}; let resuming: Promise<unknown> | undefined;
  try {
    const task = await app.tasks.create({ title: "Keep the current folder", outcome: "Finish without duplicating work", model: fixtureModel });
    await app.tasks.enqueue(task.id, "Preserve the pending correction", "retained-correction");
    const original = await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    assert.ok(original.worker.state === "bound");
    let entered = () => {}; const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    resuming = app.tasks.dispatch(task.id, host, async (command) => {
      assert.equal(command.type, "resume_worker"); entered(); await gate; return { type: "written" };
    });
    void resuming.catch(() => {}); await started;
    const claimed = await app.tasks.get(task.id);
    assert.deepEqual(claimed.worker, { ...original.worker, state: "resuming" });
    await assert.rejects(app.tasks.revokeAllocation(task.id, original.worker.allocation_id), /known session/);
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => { throw new Error("A concurrent resume must not reach Rex"); }), /already in progress/);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    let checks = 0;
    const recovered = await app.tasks.dispatch(task.id, host, async (command): Promise<HostResult> => {
      assert.ok(command.type === "on_node" && command.command.type === "inspect_worker");
      assert.deepEqual(command.command.binding, binding); checks += 1;
      return { type: "worker_presence", presence: { state: "pending" } };
    });
    assert.equal(checks, 1); assert.deepEqual(recovered.worker, original.worker);
    assert.deepEqual(recovered.pending, original.pending); assert.equal(recovered.conversation_id, original.conversation_id);
    release(); await assert.rejects(resuming); resuming = undefined;
    assert.deepEqual((await app.tasks.get(task.id)).worker, original.worker);
  } finally { release(); await resuming?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("lost resume responses retain the full folder through inconclusive inspections and reject legacy known-session revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resume-retained-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Retain interrupted work", outcome: "Keep the original task", model: fixtureModel });
    const original = await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    assert.ok(original.worker.state === "bound");
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => { throw new Error("Synthetic response loss"); }), /needs reconciliation/);
    const uncertain = { ...original.worker, state: "resume_uncertain" };
    assert.deepEqual((await app.tasks.get(task.id)).worker, uncertain);
    for (const result of [
      { type: "failed", message: "Synthetic inspection unavailable" },
      { type: "worker_presence", presence: { state: "present", running: false } },
      { type: "worker_presence", presence: { state: "missing_terminal" } },
    ] satisfies HostResult[]) {
      let checks = 0;
      await assert.rejects(app.tasks.dispatch(task.id, host, async (command) => {
        assert.ok(command.type === "on_node" && command.command.type === "inspect_worker"); checks += 1; return result;
      }), /needs reconciliation/);
      assert.equal(checks, 1); assert.deepEqual((await app.tasks.get(task.id)).worker, uncertain);
      await assert.rejects(app.tasks.revokeAllocation(task.id, original.worker.allocation_id), /known session/);
    }
    const allocationId = original.worker.allocation_id;
    await app.tasks.update(task.id, (saved) => { saved.worker = { state: "uncertain", allocation_id: allocationId, host, session_id: binding.session_id }; });
    const legacy = await app.tasks.get(task.id);
    await assert.rejects(app.tasks.revokeAllocation(task.id, allocationId), /known session/);
    assert.deepEqual((await app.tasks.get(task.id)).worker, legacy.worker);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an older missing-session observation cannot replace a newer confirmed running binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resume-stale-readback-")); const app = await open(directory);
  let release = () => {}; let slow: Promise<unknown> | undefined;
  try {
    const task = await app.tasks.create({ title: "Keep a recovered worker", outcome: "Retain its confirmed folder", model: fixtureModel });
    let spawns = 0;
    const original = await app.tasks.dispatch(task.id, host, async () => { spawns += 1; return { type: "spawned", binding }; });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "creation_uncertain", session_id: binding.session_id })).catch(() => {});
    let entered = () => {}; const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    slow = app.tasks.dispatch(task.id, host, async (command): Promise<HostResult> => {
      if (command.type === "on_node") { entered(); await gate; return { type: "worker_presence", presence: { state: "missing_session" } }; }
      assert.equal(command.type, "spawn_worker"); spawns += 1;
      return { type: "spawned", binding: { ...binding, session_id: "session:55555555-5555-4555-8555-555555555555" } };
    });
    void slow.catch(() => {}); await started;
    // A recreated coordinator has its own in-memory transition guards.
    const recreated = new TaskStore(app.session, new ConversationModels());
    const newer = await recreated.dispatch(task.id, host, async (command): Promise<HostResult> => {
      assert.ok(command.type === "on_node" && command.command.type === "inspect_worker");
      return { type: "worker_presence", presence: { state: "present", running: true } };
    });
    assert.deepEqual(newer.worker, original.worker);
    release(); await slow.catch(() => {}); slow = undefined;
    assert.equal(spawns, 1, "A stale absence must not discard a newer confirmed live session");
    assert.deepEqual((await app.tasks.get(task.id)).worker, original.worker);
  } finally { release(); await slow?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("one recovered-worker observation owns reconciliation until its native inspection completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resume-serialized-")); const app = await open(directory);
  let release = () => {}; let recovering: Promise<unknown> | undefined;
  try {
    const task = await app.tasks.create({ title: "Serialize session recovery", outcome: "Keep the same active folder", model: fixtureModel });
    const original = await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    await app.tasks.dispatch(task.id, host, async () => ({ type: "creation_uncertain", session_id: binding.session_id })).catch(() => {});
    let entered = () => {}; const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; }); let inspections = 0;
    recovering = app.tasks.dispatch(task.id, host, async (command): Promise<HostResult> => {
      assert.ok(command.type === "on_node" && command.command.type === "inspect_worker"); inspections += 1;
      entered(); await gate; return { type: "worker_presence", presence: { state: "present", running: true } };
    });
    void recovering.catch(() => {}); await started;
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => {
      inspections += 1; throw new Error("A second native observation must not race the first");
    }), /already in progress/);
    assert.equal(inspections, 1); release(); await recovering; recovering = undefined;
    assert.deepEqual((await app.tasks.get(task.id)).worker, original.worker);
  } finally { release(); await recovering?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an uncertain replacement preserves its original folder and reconciles a running worker without creating another", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resume-uncertain-")); let app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Recover the same folder", outcome: "Keep the existing task", model: fixtureModel });
    await app.tasks.enqueue(task.id, "Continue the retained task", "retained-input");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const original = await app.tasks.get(task.id); assert.ok(original.worker.state === "bound");
    await app.tasks.dispatch(task.id, host, async (): Promise<HostResult> => ({ type: "creation_uncertain", session_id: binding.session_id })).catch(() => {});
    assert.deepEqual((await app.tasks.get(task.id)).worker,
      { ...original.worker, state: "resume_uncertain" });
    await assert.rejects(app.tasks.revokeAllocation(task.id, original.worker.allocation_id));
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    let checks = 0;
    const recovered = await app.tasks.dispatch(task.id, host, async (command): Promise<HostResult> => {
      assert.equal(command.type, "on_node");
      assert.ok(command.type === "on_node" && command.command.type === "inspect_worker");
      assert.deepEqual(command.command.binding, binding); checks += 1;
      return { type: "worker_presence", presence: { state: "present", running: true } };
    });
    assert.equal(checks, 1); assert.deepEqual(recovered.worker, original.worker); assert.deepEqual(recovered.pending, original.pending);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
