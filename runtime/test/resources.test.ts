import { ConversationModels } from "../src/models.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ResourceStore, createResourceTools } from "../src/resources.js";
import { TaskStore } from "../src/tasks.js";
import { Executions } from "../src/tools.js";
import type { ResourceRecord } from "../src/generated/ResourceRecord.js";
import type { NativeWorktreeIdentity } from "../src/generated/NativeWorktreeIdentity.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { WorktreeAllocation } from "../src/generated/WorktreeAllocation.js";

const hostId = "11111111-1111-4111-8111-111111111111";
const identity: NativeWorktreeIdentity = { primary: "/workspace/example", top: "/workspace/example-review",
  common_dir: "/workspace/example/.git", git_dir: "/workspace/example/.git/worktrees/review", branch: "review", head: "abc123" };
function ready(request: WorktreeAllocation): ResourceRecord {
  return { id: request.allocation_id, host_id: request.host_id, task_id: request.task_id, repository: request.repository,
    branch: request.branch, consumers: [], state: { state: "ready", identity } };
}
async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database); const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider); const registry = createRegistry();
  const session = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)); const resources = new ResourceStore(session, tasks); tasks.guardResources(resources);
  const executions = new Executions(); const tools = createResourceTools(resources, tasks, executions); registry.install(tools);
  return { session, tasks, resources, executions, tools, faux };
}

test("resource allocation intent and consumers precede the host effect and survive reopen without another create", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resource-")); let app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Review", outcome: "Verify the change" });
    const request: WorktreeAllocation = { host_id: hostId, task_id: task.id, allocation_id: randomUUID(), repository: identity.primary, branch: "review" };
    let calls = 0;
    const call = async (command: HostCommand): Promise<HostResult> => {
      assert.equal(command.type, "resource_allocate"); calls += 1;
      assert.equal((await app.resources.list())[0]?.state.state, "allocating");
      assert.deepEqual((await app.resources.list())[0]?.consumers, [task.id]);
      return { type: "resource", report: { type: "observed", record: ready(request) } };
    };
    await app.resources.allocate(request, call); await app.resources.allocate(request, call); assert.equal(calls, 1);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    await app.resources.allocate(request, call); assert.equal(calls, 1);
    assert.deepEqual((await app.resources.list())[0]?.consumers, [task.id]);
    const uncertain = { ...request, allocation_id: randomUUID(), branch: "uncertain" };
    const held = await app.resources.allocate(uncertain, async () => { throw new Error("Lost native receipt"); });
    assert.equal(held.state.state, "held");
    await app.resources.allocate(uncertain, async () => { throw new Error("An uncertain allocation must not be recreated"); });
    assert.equal((await app.resources.list()).length, 2);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("unsettled child consumers and other hosts hold resources; retiring blocks reuse before native removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resource-")); let app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Review", outcome: "Verify the change" });
    const request: WorktreeAllocation = { host_id: hostId, task_id: task.id, allocation_id: randomUUID(), repository: identity.primary, branch: "review" };
    await app.resources.allocate(request, async () => ({ type: "resource", report: { type: "observed", record: ready(request) } }));
    const childId = randomUUID();
    await app.tasks.createAgent(task.id, { id: childId, title: "Review", outcome: "Review change", input: "Inspect change", inputId: randomUUID() });
    await app.tasks.update(task.id, (saved) => { saved.state = { state: "resolved", evidence: "Parent finished" }; });
    let calls = 0;
    await app.resources.collect(hostId, async () => { calls += 1; return { type: "written" }; }); assert.equal(calls, 0);
    await app.tasks.reportAgent(task.id, childId, "Verified");
    await app.tasks.update(task.id, (saved) => { const child = saved.agents[0]; if (child !== undefined) child.pending = []; });
    await app.resources.collect("another-host", async () => { calls += 1; return { type: "written" }; }); assert.equal(calls, 0);
    const planId = randomUUID();
    await assert.rejects(app.resources.collect(hostId, async (command) => {
      calls += 1;
      if (command.type === "resource_inspect") return { type: "resource", report: { type: "observed", record: { ...command.record, state: { state: "ready", identity } } } };
      if (command.type === "resource_plan_cleanup") return { type: "resource", report: { type: "planned", record: {
        ...command.record, state: { state: "retiring", identity, plan_id: planId },
      }, plan: { id: planId, resource_id: request.allocation_id, identity, path: "/private/plans/example.json", fingerprint: "fixture" } } };
      assert.equal(command.type, "resource_collect");
      assert.equal((await app.resources.list())[0]?.state.state, "retiring");
      await assert.rejects(app.tasks.enqueue(task.id, "Reuse while retiring"), /retiring/);
      assert.equal((await app.tasks.get(task.id)).pending.length, 0);
      throw new Error("Lost collect receipt");
    }), /Lost collect receipt/);
    assert.equal(calls, 3);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal((await app.resources.list())[0]?.state.state, "retiring");
    await app.resources.collect(hostId, async (command) => {
      assert.equal(command.type, "resource_collect");
      if (command.type !== "resource_collect") throw new Error("Expected persisted exact plan");
      assert.equal(command.plan.id, planId);
      return { type: "resource", report: { type: "collected", record: { ...command.record, state: { state: "removed", identity } },
        receipt: { status: "removed", worktree_removed: true, branch_deleted: "review", primary_worktree: identity.primary, retained_submodules: null, summary: "Removed owned merged worktree" } } };
    });
    assert.equal((await app.resources.list())[0]?.state.state, "removed");
    await app.resources.collect(hostId, async () => { throw new Error("Removed resource must stay removed"); });
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("new work during cleanup planning retains the consumer and prevents native collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resource-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Review", outcome: "Finish review" });
    const request: WorktreeAllocation = { host_id: hostId, task_id: task.id, allocation_id: randomUUID(), repository: identity.primary, branch: "review" };
    await app.resources.allocate(request, async () => ({ type: "resource", report: { type: "observed", record: ready(request) } }));
    await app.tasks.update(task.id, (saved) => { saved.state = { state: "resolved", evidence: "Verified" }; });
    await assert.rejects(app.resources.collect(hostId, async (command) => {
      if (command.type === "resource_inspect") return { type: "resource", report: { type: "observed", record: command.record } };
      if (command.type !== "resource_plan_cleanup") throw new Error("Native collection must not run");
      await app.tasks.enqueue(task.id, "Inspect the new follow-up");
      const id = randomUUID();
      return { type: "resource", report: { type: "planned", record: { ...command.record, state: { state: "retiring", identity, plan_id: id } },
        plan: { id, resource_id: request.allocation_id, identity, path: "/private/plans/example.json", fingerprint: "fixture" } } };
    }), /acquired a consumer/);
    assert.equal((await app.resources.list())[0]?.state.state, "ready");
    assert.deepEqual((await app.resources.list())[0]?.consumers, [task.id]);
    assert.equal((await app.tasks.get(task.id)).pending.length, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("one task retains multiple repository worktrees and their independent cleanup outcomes after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resource-")); let app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Update clients", outcome: "Merge both repository changes" });
    const requests: WorktreeAllocation[] = ["client", "server"].map((name) => ({
      allocation_id: randomUUID(), host_id: hostId, task_id: task.id, repository: `/workspace/${name}`, branch: "update",
    }));
    for (const request of requests) {
      const record = ready(request);
      record.state = { state: "ready", identity: { ...identity, primary: request.repository,
        top: request.repository + "-update", common_dir: request.repository + "/.git",
        git_dir: request.repository + "/.git/worktrees/update", branch: request.branch } };
      await app.resources.allocate(request, async () => ({ type: "resource", report: { type: "observed", record } }));
    }
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.deepEqual((await app.resources.list()).map((record) => record.id), requests.map((request) => request.allocation_id));
    assert.deepEqual((await app.resources.list()).map((record) => record.task_id), [task.id, task.id]);
    await app.tasks.update(task.id, (saved) => { saved.state = { state: "resolved", evidence: "Both changes verified" }; });
    const collected: string[] = [];
    await app.resources.collect(hostId, async (command) => {
      if (command.type === "resource_inspect") return { type: "resource", report: { type: "observed", record: command.record } };
      if (command.type === "resource_plan_cleanup") {
        if (command.record.state.state !== "ready") throw new Error("Only ready resources are planned");
        const ownIdentity = command.record.state.identity;
        if (command.record.repository === "/workspace/server") return { type: "resource", report: { type: "observed",
          record: { ...command.record, state: { state: "held", identity: ownIdentity, reason: "Uncommitted changes" } } } };
        const id = randomUUID();
        return { type: "resource", report: { type: "planned",
          record: { ...command.record, state: { state: "retiring", identity: ownIdentity, plan_id: id } },
          plan: { id, resource_id: command.record.id, identity: ownIdentity, path: "/private/plans/client.json", fingerprint: "fixture" } } };
      }
      if (command.type !== "resource_collect") throw new Error("Unexpected resource effect");
      collected.push(command.record.repository);
      return { type: "resource", report: { type: "collected", record: { ...command.record, state: { state: "removed", identity: command.plan.identity } },
        receipt: { status: "completed", worktree_removed: true, branch_deleted: command.record.branch,
          primary_worktree: command.record.repository, retained_submodules: null, summary: "Removed merged client worktree" } } };
    });
    assert.deepEqual(collected, ["/workspace/client"]);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const records = await app.resources.list();
    assert.equal(records.length, 2);
    assert.equal(records.find((record) => record.repository === "/workspace/client")?.state.state, "removed");
    assert.equal(records.find((record) => record.repository === "/workspace/server")?.state.state, "held");
    assert.ok(records.every((record) => record.task_id === task.id));
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("the real model tool allocates only for its owning bound task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-resource-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Review", outcome: "Inspect safely" });
    const binding = { host_id: hostId, session_id: "session:22222222-2222-4222-8222-222222222222",
      window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
    const host = { name: "fixture", rex_server: null, coordinator: null, cwd: identity.primary, agent_program: "/example/agent" };
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const conversation = await app.tasks.conversation(task.conversation_id);
    const release = app.executions.bind(conversation.id.toString(), { cwd: identity.primary, hosts: [host], call: async (command) => {
      assert.equal(command.type, "resource_allocate"); if (command.type !== "resource_allocate") throw new Error("Expected owned allocation");
      assert.equal(command.request.task_id, task.id); assert.equal(command.request.host_id, hostId);
      return { type: "resource", report: { type: "observed", record: ready(command.request) } };
    } });
    try {
      await conversation.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools] }, BACKGROUND_CONTEXT);
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("allocate_worktree", { repository: identity.primary, branch: "review" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Allocated the review worktree."),
      ]);
      assert.equal((await (await conversation.submit({ type: "input", content: "Use an owned worktree" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
      assert.equal((await app.resources.list()).length, 1);
    } finally { release(); }
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
