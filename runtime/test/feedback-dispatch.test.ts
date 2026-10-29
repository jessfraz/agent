import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CoordinatorEnvironment } from "../src/environment.js";
import { FeedbackDispatcher } from "../src/feedback-dispatch.js";
import { FeedbackStore } from "../src/feedback.js";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { FeedbackContext } from "../src/generated/FeedbackContext.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { fixtureModel } from "./model.js";
import { AttachmentStore } from "../src/attachments.js";

const coordinator: AgentNode = { host_id: "11111111-1111-4111-8111-111111111111", name: "coordinator", rex_server: null,
  coordinator: null, home_directory: "/home/coordinator", agent_program: "/example/bin/agent",
  launch: { state_dir: null, runtime: null, config: null, instructions: null, model: fixtureModel } };
const linux: AgentNode = { ...coordinator, host_id: "22222222-2222-4222-8222-222222222222", name: "linux",
  home_directory: "/home/linux", coordinator: "synthetic-coordinator" };
const parent: WorkerRef = { host_id: linux.host_id, session_id: "session:33333333-3333-4333-8333-333333333333",
  window_id: "window:44444444-4444-4444-8444-444444444444", block_id: "block:55555555-5555-4555-8555-555555555555" };
const binding: WorkerRef = { ...parent, window_id: "window:66666666-6666-4666-8666-666666666666", block_id: "block:77777777-7777-4777-8777-777777777777" };
const context: FeedbackContext = { origin_host_id: linux.host_id, cwd: "/home/linux/project", conversation_id: null,
  task_id: null, agent_id: null, model: fixtureModel, binding: parent, draft: "", queued_inputs: [], client_errors: [] };

async function open(directory: string) {
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models));
  const attachments = new AttachmentStore(directory); tasks.useAttachments(attachments);
  const environment = new CoordinatorEnvironment(session); tasks.useEnvironment(environment);
  await environment.configure({ settings: { model: fixtureModel, instructions: "Use the existing checkout.", context_repositories: [], sources: [] }, node: coordinator });
  await environment.register(linux); environment.setConnected([coordinator.host_id, linux.host_id]);
  const store = new FeedbackStore(directory, tasks);
  return { session, tasks, environment, store, attachments, dispatcher: new FeedbackDispatcher(store, tasks, environment), faux };
}

test("feedback retries keep one durable report and attachment assignment before and after repair admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-feedback-identity-")); let app = await open(directory);
  let spawns = 0;
  const call: HostCall = async (command) => { assert.equal(command.type, "spawn_worker"); spawns += 1; return { type: "spawned", binding }; };
  try {
    const id = "88888888-8888-4888-8888-888888888888", attachmentId = "99999999-9999-4999-8999-999999999999";
    const uploaded = await app.attachments.request({ type: "upload", id: attachmentId, name: "terminal.html", media_type: "text/html", size_bytes: 5, offset: 0, data_base64: Buffer.from("frame").toString("base64"), complete: true });
    assert.ok(uploaded.type === "uploaded" && uploaded.attachment !== null);
    const attachment = uploaded.attachment, input = { ...context, attachments: [attachment] };
    const [first, second] = await Promise.all([app.store.capture("Inspect this rendering", input, id), app.store.capture("Inspect this rendering", input, id)]);
    assert.deepEqual(first, second); assert.equal(first.id, id);
    const receipt = await app.dispatcher.dispatch(first, call);
    assert.deepEqual((await app.tasks.get(receipt.task_id)).pending[0]?.attachments, [attachment]);
    app.environment.setConnected([coordinator.host_id]);
    assert.deepEqual(await app.dispatcher.dispatch(second, call), receipt, "An uncertain reply retry returns the durable acknowledgment even if the worker is now offline");
    assert.equal(spawns, 1); assert.equal((await app.tasks.get(receipt.task_id)).pending.length, 1);
    await assert.rejects(app.store.capture("Changed report", input, id), /different content/);
    await assert.rejects(app.store.capture("Inspect this rendering", { ...input, attachments: [] }, id), /different content/);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.deepEqual(await app.store.capture("Inspect this rendering", input, id), first);
    assert.deepEqual(await app.dispatcher.dispatch(first, call), receipt); assert.equal(spawns, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("feedback starts a Linux repair in its current Rex folder, reuses it, and publishes its answer in main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-feedback-dispatch-")); let app = await open(directory);
  const effects: HostCommand[] = [];
  const call: HostCall = async (command) => {
    effects.push(command);
    if (command.type === "spawn_worker") {
      assert.equal(command.host.host_id, linux.host_id); assert.equal(command.host.cwd, context.cwd);
      assert.deepEqual(command.parent, parent); return { type: "spawned", binding };
    }
    assert.equal(command.type, "resume_worker");
    if (command.type !== "resume_worker") throw new Error("Unexpected feedback effect");
    assert.equal(command.host.host_id, linux.host_id); assert.deepEqual(command.binding, binding);
    return { type: "written" };
  };
  try {
    const bundle = await app.store.capture("Reuse the related task instead of making a new folder.", context);
    const receipt = await app.dispatcher.dispatch(bundle, call);
    let task = await app.tasks.get(receipt.task_id); assert.ok(task.worker.state === "bound");
    assert.equal(receipt.id, bundle.id); assert.equal(receipt.path, app.store.path(bundle.id));
    assert.ok(task.pending[0]?.content.includes(`agent --json feedback show ${bundle.id}`));
    assert.equal((await app.tasks.list()).length, 1);
    app.faux.setResponses([fauxAssistantMessage("The reported routing issue is fixed and the regression passes.")]);
    await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: task.worker.allocation_id,
      binding, instructions: "Repair the reported behavior.", model: fixtureModel, cwd: context.cwd }, () => () => {}, () => {});
    const main = await app.session.root(BACKGROUND_CONTEXT);
    const entries = (await main.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT)).items;
    assert.ok(entries.some((entry) => entry.kind === "agent.notice" && entry.model?.some((message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text.includes("regression passes")))));
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const next = await app.store.capture("Also preserve the queued correction.", context);
    const continued = await app.dispatcher.dispatch(next, call);
    assert.equal(continued.task_id, receipt.task_id); assert.equal((await app.tasks.list()).length, 1);
    task = await app.tasks.get(continued.task_id); assert.ok(task.worker.state === "bound"); assert.deepEqual(task.worker.binding, binding);
    assert.deepEqual(effects.map((command) => command.type), ["spawn_worker", "resume_worker"]);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent raw CLI feedback opens one initial repair folder and reuses it without dropping either request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-feedback-concurrent-")); const app = await open(directory);
  let spawns = 0;
  try {
    const raw = { ...context, binding: null };
    const first = await app.store.capture("First report.", raw), second = await app.store.capture("Second report.", raw);
    const call: HostCall = async (command) => {
      if (command.type === "spawn_worker") { assert.equal(command.parent, undefined); spawns += 1; return { type: "spawned", binding }; }
      assert.equal(command.type, "resume_worker"); return { type: "written" };
    };
    const [left, right] = await Promise.all([app.dispatcher.dispatch(first, call), app.dispatcher.dispatch(second, call)]);
    assert.equal(left.task_id, right.task_id); assert.equal(spawns, 1);
    assert.deepEqual((await app.tasks.get(left.task_id)).pending.map((item) => item.id), ["feedback:" + first.id, "feedback:" + second.id]);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("offline or mismatched feedback origins retain the capture and never fall back to the coordinator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-feedback-offline-")); const app = await open(directory);
  let effects = 0; const call: HostCall = async () => { effects += 1; return { type: "failed", message: "No effect expected" }; };
  try {
    const bundle = await app.store.capture("Investigate this failure.", context);
    app.environment.setConnected([coordinator.host_id]);
    await assert.rejects(app.dispatcher.dispatch(bundle, call), /originating machine is offline/);
    assert.equal((await app.store.read(bundle.id)).id, bundle.id);
    app.environment.setConnected([coordinator.host_id, linux.host_id]);
    const mismatched = await app.store.capture("Wrong host identity.", { ...context, binding: { ...parent, host_id: coordinator.host_id } });
    await assert.rejects(app.dispatcher.dispatch(mismatched, call), /terminal belongs to another machine/);
    assert.equal(effects, 0); assert.equal((await app.tasks.list()).length, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
