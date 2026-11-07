import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AgentDoc, createRegistry, GenerationTask, Harness, InboxDoc, LiveDoc, UserEntry,
  type GenerationCheckpoint } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ConversationCatalog } from "../src/catalog.js";
import { openConversationDatabase } from "../src/conversation-database.js";
import { ConversationViews } from "../src/conversation-views.js";
import { CoordinatorEnvironment } from "../src/environment.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { ScheduledOccurrence } from "../src/generated/ScheduledOccurrence.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { HistoryStore } from "../src/history.js";
import { ConversationModels, DEFAULT_MODEL } from "../src/models.js";
import { SourceJournal } from "../src/sources.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { Executions } from "../src/tools.js";

const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111",
  session_id: "session:22222222-2222-4222-8222-222222222222", window_id: "window:33333333-3333-4333-8333-333333333333",
  block_id: "block:44444444-4444-4444-8444-444444444444" };

async function open(directory: string) {
  const models = builtinModels(), registry = createRegistry();
  const storage = await SqliteStorage.open(await openConversationDatabase(join(directory, "session.sqlite")));
  const harness = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const inference = new ConversationModels(models), tasks = new TaskStore(harness, inference), histories = new HistoryStore(harness);
  const environment = new CoordinatorEnvironment(harness); tasks.useEnvironment(environment); tasks.useHistory(histories);
  await environment.configure({ node: { host_id: binding.host_id, name: "fixture", rex_server: null, coordinator: null,
    agent_program: process.execPath, home_directory: directory,
    launch: { state_dir: directory, runtime: null, config: null, instructions: null, model: DEFAULT_MODEL } },
  settings: { model: DEFAULT_MODEL, instructions: "Current workflow guidance", context_repositories: [], sources: [] } });
  environment.setConnected([binding.host_id]);
  const catalog = new ConversationCatalog(harness, histories, tasks), sources = new SourceJournal(harness, tasks);
  const services = { harness, tasks, histories, inference, environment, catalog, sources };
  const views = new ConversationViews(async () => services, () => {});
  return { ...services, storage, views };
}
function occurrence(id: string, cwd: string, model = DEFAULT_MODEL): ScheduledOccurrence {
  return { id, schedule_id: "daily", scheduled_at: 1, job: { id: "example-review", title: "Example review",
    prompt: `Captured policy for ${id}`, revision: id, cwd, model, timezone: "Etc/UTC",
    schedules: [{ id: "daily", recurrence: "DTSTART:20270101T090000Z\nRRULE:FREQ=DAILY", focus: null, prompt: null }] } };
}
async function until(predicate: () => Promise<boolean>, message = "The attached worker did not reach its native admission boundary"): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await setImmediate();
  }
  assert.fail(message);
}

for (const boundaryHeld of [false, true]) {
  test(`public steering reaches scheduled work ${boundaryHeld ? "after its configuration boundary" : "while active"} without bypassing queued job settings`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-scheduled-steering-")), current = occurrence("current-job", join(directory, "current"));
    let app = await open(directory);
    const host: WorkerHost = { host_id: binding.host_id, name: "fixture", rex_server: null, coordinator: null,
      agent_program: process.execPath, cwd: current.job.cwd };
    const task = await app.tasks.create({ title: current.job.title, outcome: current.job.prompt, model: current.job.model,
      sources: [{ provider: "scheduled_jobs", account: "local", thread_id: current.job.id }] });
    const allocation = "55555555-5555-4555-8555-555555555555";
    await app.tasks.update(task.id, saved => { saved.worker = { state: "bound", allocation_id: allocation, host, binding }; });
    await app.tasks.enqueueScheduled(task.id, "Current scheduled request", current);
    let conversation = await app.tasks.conversation(task.conversation_id);
    await app.inference.configure(conversation, current.job.model, { instructions: current.job.prompt, cwd: current.job.cwd });
    // Restore an admitted scheduled turn at a real Pi retry checkpoint. It stays
    // in the future, so no provider request or substituted model is needed.
    const native = await conversation.commit(async tx => {
      const entry = await tx.appendEntry(UserEntry, conversation.id,
        { model: [{ role: "user", content: "Current scheduled request", timestamp: 1 }] });
      const submission = await tx.createSubmission({ type: "input", conversationId: conversation.id,
        requestId: current.id, status: "placed", entry: entry.id });
      const generation = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } });
      const live = await tx.doc(LiveDoc, conversation.id);
      live.run = { taskId: generation, inputs: [submission.id] }; live.generation = { attempt: 1 };
      return { generation, submission: submission.id };
    }, BACKGROUND_CONTEXT);
    const record = await app.harness.getTask(native.generation, BACKGROUND_CONTEXT); assert.ok(record);
    const deadline = Date.now() + 3_600_000;
    const checkpoint: GenerationCheckpoint = { phase: "retry", attempt: 1, until: deadline };
    await app.storage.commit([{ type: "task", value: { ...record, state: { status: "sleeping", until: deadline, checkpoint } } }], BACKGROUND_CONTEXT);
    app.views.close(); app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT);
    app = await open(directory); conversation = await app.tasks.conversation(task.conversation_id);
    const controller = new AbortController(), executions = new Executions();
    let enterBoundary = () => {}, releaseBoundary = () => {};
    const boundary = new Promise<void>(resolve => { enterBoundary = resolve; });
    const released = new Promise<void>(resolve => { releaseBoundary = resolve; });
    let worker: Promise<unknown> | undefined, hostCalls = 0;
    const noHost: HostCall = async () => { hostCalls += 1; assert.fail("Native input admission must not call an external host"); };
    try {
      const command: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id,
        allocation_id: allocation, binding, instructions: "Current workflow guidance", model: current.job.model,
        cwd: current.job.cwd, interactive: true };
      worker = app.tasks.run(command, (nativeConversation, executionHost, model) => executions.bind(nativeConversation.id.toString(),
        { cwd: executionHost.cwd, hosts: [executionHost], model, role: "worker", call: noHost }), [], noHost, undefined,
      { signal: controller.signal, async ready() {}, answer() { assert.fail("The retained native turn has not answered"); }, idle() {},
        async beforeTurn() { if (boundaryHeld) { enterBoundary(); await released; } } });
      if (boundaryHeld) await boundary;
      else await until(async () => (await app.tasks.get(task.id)).pending.length === 0);
      const activeConfiguration = await app.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT); assert.ok(activeConfiguration);
      const alternative = app.inference.catalog().find(model => model.provider === DEFAULT_MODEL.provider && model.model_id !== DEFAULT_MODEL.model_id);
      assert.ok(alternative);
      const laterModel = { provider: alternative.provider, model_id: alternative.model_id, reasoning: null, fast: false };
      const second = occurrence("second-job", join(directory, "second"), laterModel), third = occurrence("third-job", join(directory, "third"));
      await app.tasks.enqueueScheduled(task.id, "Second scheduled request", second);
      await app.tasks.enqueueScheduled(task.id, "Third scheduled request", third);
      const frames: RuntimeEventKind[] = [];
      const input = (id: string, mode: "steer" | "follow_up") => app.views.input({ type: "conversation_input",
        conversation_id: task.conversation_id, input_id: id, input: `Context for ${id}`, mode, origin: "cli" }, noHost, event => frames.push(event));
      const receipt = (id: string) => app.harness.commit(tx => tx.submissionByRequest(conversation.id, id), BACKGROUND_CONTEXT);
      await input("later-context", "follow_up");
      await input("current-correction", "steer");
      if (boundaryHeld) {
        assert.equal(await receipt("current-correction"), undefined, "Configuration must finish before admitting the retained steer");
        releaseBoundary();
        await until(async () => await receipt("current-correction") !== undefined,
          "Steering accepted at the configuration boundary must reach Pi when that scheduled turn starts");
      }
      const steering = await receipt("current-correction");
      assert.ok(steering, "An explicit steer must reach Pi before the active scheduled turn completes, despite queued later jobs");
      assert.equal(steering.status, "queued");
      const inbox = await app.harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT);
      assert.deepEqual(inbox?.items.map(item => ({ id: item.id, mode: item.mode })), [{ id: steering.id, mode: "steer" }]);
      for (const id of [second.id, third.id, "later-context"]) assert.equal(await receipt(id), undefined);
      assert.deepEqual((await app.tasks.get(task.id)).pending.map(item => item.id), [second.id, third.id, "later-context", "current-correction"]);
      assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT), activeConfiguration);
      assert.deepEqual((await app.tasks.get(task.id)).model, current.job.model);
      assert.equal((await app.harness.getTask(native.generation, BACKGROUND_CONTEXT))?.state.status, "sleeping");
      assert.equal((await receipt(current.id))?.status, "placed");
      await input("current-correction", "steer");
      assert.equal((await receipt("current-correction"))?.id, steering.id, "Reconciliation must reuse the original native input");
      assert.equal((await app.harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT))?.items.length, 1);
      assert.equal(frames.some(frame => frame.type === "input_accepted" && frame.input_id === "current-correction"), true);

      controller.abort();
      await app.tasks.enqueue(task.id, "Retain after stop", "after-stop", undefined, "steer");
      assert.equal(await receipt("after-stop"), undefined, "A detached observer must not inject steering into its old turn");
      await conversation.abort(BACKGROUND_CONTEXT); await worker; worker = undefined;
      for (const id of [second.id, third.id, "later-context", "after-stop"]) assert.equal(await receipt(id), undefined);
      assert.deepEqual((await app.tasks.get(task.id)).pending.filter(item => item.scheduled !== undefined).map(item => item.id), [second.id, third.id]);
      assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT), activeConfiguration);
      assert.equal(hostCalls, 0);
    } finally {
      controller.abort(); releaseBoundary(); await conversation.abort(BACKGROUND_CONTEXT); await worker?.catch(() => {});
      app.views.close(); app.catalog.close(); await app.harness.close(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
