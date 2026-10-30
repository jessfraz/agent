import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { AttachmentStore, validateInput } from "../src/attachments.js";
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_NAME_BYTES } from "../src/generated/attachment-limits.js";
import type { AttachmentRef } from "../src/generated/AttachmentRef.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { Executions, createAppTools } from "../src/tools.js";
import { history } from "../src/transcript.js";
import { fixtureModel } from "./model.js";
import { CoordinatorEnvironment } from "../src/environment.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
async function upload(store: AttachmentStore, bytes: Buffer, name = "evidence.txt", media_type = "text/plain"): Promise<AttachmentRef> {
  const id = randomUUID();
  for (let offset = 0; offset <= bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
    const end = Math.min(offset + ATTACHMENT_CHUNK_BYTES, bytes.length);
    const response = await store.request({ type: "upload", id, name, media_type, size_bytes: bytes.length, offset,
      data_base64: bytes.subarray(offset, end).toString("base64"), complete: end === bytes.length });
    assert.equal(response.type, "uploaded");
    if (response.type === "uploaded" && response.attachment !== null) return response.attachment;
  }
  throw new Error("Missing upload receipt");
}

test("attachments survive partial retries and restart, enforce immutable receipts, and retain only admitted originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-attachment-")); let store = new AttachmentStore(directory);
  try {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 7, 42), id = randomUUID();
    const request = { type: "upload", id, name: "report.txt", media_type: "text/plain", size_bytes: bytes.length, offset: 0,
      data_base64: bytes.subarray(0, 7).toString("base64"), complete: false } satisfies Parameters<AttachmentStore["request"]>[0];
    await store.request(request); store = new AttachmentStore(directory);
    await store.request({ ...request, data_base64: bytes.subarray(0, ATTACHMENT_CHUNK_BYTES).toString("base64") });
    const last = { ...request, offset: ATTACHMENT_CHUNK_BYTES, data_base64: bytes.subarray(ATTACHMENT_CHUNK_BYTES).toString("base64"), complete: true };
    const completed = await store.request(last); assert.equal(completed.type, "uploaded");
    if (completed.type !== "uploaded" || completed.attachment === null) throw new Error("Missing receipt");
    assert.deepEqual(await store.request(last), completed);
    await assert.rejects(store.request({ ...request, data_base64: Buffer.from("changed").toString("base64") }), /changed its bytes/);
    await assert.rejects(store.retain([{ ...completed.attachment, sha256: "0".repeat(64) }]), /receipt/);
    assert.deepEqual(await store.retain([completed.attachment]), [completed.attachment]);
    await assert.rejects(store.request({ type: "discard", id }), /retained/);
    const read = await store.request({ type: "download", id, offset: ATTACHMENT_CHUNK_BYTES, limit: 16 });
    assert.deepEqual(read, { type: "download", data_base64: bytes.subarray(ATTACHMENT_CHUNK_BYTES).toString("base64"), next_offset: null });
    assert.equal((await stat(join(directory, "attachments", id, "content"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "attachments"))).mode & 0o777, 0o700);
    const orphan = await upload(store, Buffer.from("unused"));
    const metadataPath = join(directory, "attachments", orphan.id, "metadata.json");
    // Exercise expiry of an abandoned staged upload through the real next-upload collector.
    await writeFile(metadataPath, JSON.stringify({ attachment: orphan, retained: false, complete: true, created: 0 }));
    const uncommitted = randomUUID(); await mkdir(join(directory, "attachments", uncommitted));
    await writeFile(join(directory, "attachments", uncommitted, "content"), "Never returned a receipt");
    const fresh = await upload(store, Buffer.alloc(0));
    assert.equal((await readdir(join(directory, "attachments"))).includes(orphan.id), false);
    assert.equal((await readdir(join(directory, "attachments"))).includes(uncommitted), false);
    assert.deepEqual(await new AttachmentStore(directory).references([id]), [completed.attachment]);
    await store.request({ type: "discard", id: fresh.id });
    await assert.rejects(store.references([fresh.id]), /ENOENT/);
    assert.throws(() => validateInput(""), /text or an attachment/); validateInput("", [completed.attachment]);
    await assert.rejects(store.request({ ...request, id: randomUUID(), name: "../escape" }), /metadata/);
    const boundedName = await upload(store, Buffer.alloc(0), "n".repeat(MAX_ATTACHMENT_NAME_BYTES));
    await store.request({ type: "discard", id: boundedName.id });
    await assert.rejects(upload(store, Buffer.alloc(0), "n".repeat(MAX_ATTACHMENT_NAME_BYTES + 1)), /metadata/);
    await assert.rejects(store.request({ ...request, id: randomUUID(), data_base64: "YQ" }), /encoding/);
    await assert.rejects(store.request({ ...request, id: randomUUID(), size_bytes: MAX_ATTACHMENT_BYTES + 1 }), /metadata/);
    const unavailable = await upload(store, Buffer.from("host offline"));
    await assert.rejects(store.input("", [unavailable], async () => ({ type: "failed", message: "Host unavailable" })), /Host unavailable/);
    await store.request({ type: "discard", id: unavailable.id });
    const invalidImage = await upload(store, Buffer.from("not an image"), "broken.png", "image/png");
    await assert.rejects(store.input("", [invalidImage], async (command) => {
      assert.ok(command.type === "attachment_write"); return { type: "attachment_written", next_offset: command.attachment.size_bytes, path: "/invented/private/broken.png" };
    }), /image could not be prepared/);
    await store.request({ type: "discard", id: invalidImage.id });
    const readOnly = await upload(store, Buffer.from("Inspection does not admit input"));
    await store.input("", [readOnly], async (command) => {
      assert.ok(command.type === "attachment_write"); return { type: "attachment_written", next_offset: command.attachment.size_bytes, path: "/invented/private/read-only.txt" };
    });
    assert.equal(await store.admit([readOnly], () => undefined), undefined);
    await store.request({ type: "discard", id: readOnly.id });
    const vector = await upload(store, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), "screen.svg", "image/svg+xml");
    const original = await store.input("Inspect vector", [vector], async (command) => {
      assert.ok(command.type === "attachment_write"); return { type: "attachment_written", next_offset: command.attachment.size_bytes, path: "/invented/private/screen.svg" };
    });
    assert.ok(Array.isArray(original.content)); assert.equal(original.content.some((part) => part.type === "image"), false);
    assert.ok(original.content.some((part) => part.type === "text" && part.text.includes("/invented/private/screen.svg")));
    await store.request({ type: "discard", id: vector.id });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("upload quota reserves unfinished declared sizes before bytes arrive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-attachment-quota-")); const store = new AttachmentStore(directory);
  try {
    for (let i = 0; i < 31; i += 1) await store.request({ type: "upload", id: randomUUID(), name: "pending.bin", media_type: "application/octet-stream",
      size_bytes: MAX_ATTACHMENT_BYTES, offset: 0, data_base64: "", complete: false });
    await assert.rejects(store.request({ type: "upload", id: randomUUID(), name: "overflow.bin", media_type: "application/octet-stream",
      size_bytes: MAX_ATTACHMENT_BYTES, offset: 0, data_base64: "", complete: false }), /storage is full/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const host: WorkerHost = { host_id: "11111111-1111-4111-8111-111111111111", name: "worker", rex_server: null, coordinator: null,
  cwd: "/invented/remote/project", agent_program: "/invented/bin/agent" };
const binding = { host_id: host.host_id ?? "", session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };

test("Pi receives native images and delegation keeps immutable files on each actor's execution host", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-attachment-model-"));
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)), store = new AttachmentStore(directory), executions = new Executions(); tasks.useAttachments(store);
  const tools = createAppTools(tasks, executions); registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker); registry.install(tools.agent);
  const writes: string[] = [];
  const call = (machine: string): HostCall => async (command) => {
    if (command.type === "spawn_worker") return { type: "spawned", binding };
    if (command.type !== "attachment_write") throw new Error(`Unexpected attachment effect ${command.type}`);
    const bytes = Buffer.from(command.data_base64, "base64"); assert.ok(bytes.length <= ATTACHMENT_CHUNK_BYTES);
    writes.push(machine + ":" + command.attachment.id);
    return { type: "attachment_written", next_offset: command.offset + bytes.length,
      path: command.complete ? `/invented/${machine}/private/${command.attachment.id}` : null };
  };
  try {
    const image = await upload(store, png, "screen.png", "image/png"), file = await upload(store, Buffer.from("exact file evidence"));
    const environment = new CoordinatorEnvironment(session);
    const mainCall: HostCall = async (command) => {
      const routed = environment.route(command, host);
      if (command.type !== "attachment_write") return call("coordinator")(routed);
      assert.ok(routed.type === "on_node", "Main attachment materialization must follow the same selected host as read_file");
      assert.equal(routed.host_id, host.host_id);
      return call("coordinator")(routed.command);
    };
    const task = await tasks.create({ title: "Use evidence", outcome: "Review supplied files", model: fixtureModel });
    const rejected = await upload(store, Buffer.from("Never admitted"));
    await assert.rejects(tasks.enqueue(randomUUID(), "Unknown task", randomUUID(), undefined, undefined, [rejected]), /Unknown task/);
    await store.request({ type: "discard", id: rejected.id });
    const rejectedAgent = await upload(store, Buffer.from("No owning task"));
    await assert.rejects(tasks.createAgent(randomUUID(), { id: "review", title: "Review", outcome: "Inspect evidence", input: "Review", inputId: randomUUID(), model: fixtureModel, attachments: [rejectedAgent] }), /Unknown task/);
    await store.request({ type: "discard", id: rejectedAgent.id });
    const root = await session.root(BACKGROUND_CONTEXT);
    let entered = () => {}, releaseTransaction = () => {};
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const transaction = session.commit(async () => {
      entered(); await released; await store.retain([file]);
    }, BACKGROUND_CONTEXT);
    await locked;
    const concurrentAdmission = store.admit([file], () => {
      releaseTransaction();
      return root.submit({ type: "write", entry: { kind: "fixture", model: [] } }, BACKGROUND_CONTEXT);
    });
    await Promise.all([transaction, concurrentAdmission]);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools.host, tools.main] }, BACKGROUND_CONTEXT);
    const release = executions.bind(root.id.toString(), { model: fixtureModel, cwd: host.cwd, hosts: [host], default_host: host, call: mainCall });
    faux.setResponses([(context) => {
      const user = context.messages.findLast((message) => message.role === "user"); assert.ok(user && Array.isArray(user.content));
      assert.ok(user.content.some((part) => part.type === "image" && part.mimeType === "image/png" && part.data.length > 0));
      return fauxAssistantMessage(fauxToolCall("delegate_task", { task_id: task.id, input: "", attachments: [image.id, file.id] }), { stopReason: "toolUse" });
    }, fauxAssistantMessage("Delegated the evidence.")]);
    const prepared = await store.input("Review this screen", [image, file], mainCall);
    const submission = await store.admit([image, file], () => root.submit({ type: "input", ...prepared, requestId: randomUUID() }, BACKGROUND_CONTEXT));
    assert.ok(submission); await submission.wait(BACKGROUND_CONTEXT); release();
    const saved = await tasks.get(task.id); assert.ok(saved.worker.state === "bound"); assert.deepEqual(saved.pending[0]?.attachments, [image, file]);
    assert.equal(saved.pending[0]?.content, "");
    const visible = (await history(root, null, session)).flatMap((frame) => frame.messages).filter((message) => message.role === "user");
    assert.deepEqual(visible.map((message) => ({ text: message.text, attachments: message.attachments })), [{ text: "Review this screen", attachments: [image, file] }]);
    faux.setResponses([(context) => {
      const user = context.messages.findLast((message) => message.role === "user"); assert.ok(user && Array.isArray(user.content));
      assert.ok(user.content.some((part) => part.type === "text" && part.text.includes("/invented/worker/private/")));
      assert.equal(user.content.some((part) => part.type === "text" && part.text.includes("/invented/coordinator/private/")), false);
      assert.ok(user.content.some((part) => part.type === "image")); return fauxAssistantMessage("Worker read the supplied evidence.");
    }]);
    await tasks.run({ type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id, binding, instructions: "Use attached evidence", model: fixtureModel, cwd: host.cwd }, () => () => {}, [], call("worker"));
    assert.ok(writes.includes("coordinator:" + file.id)); assert.ok(writes.includes("worker:" + file.id));
    const workerMessages = (await history(await tasks.conversation(task.conversation_id), null, session)).flatMap((frame) => frame.messages);
    assert.ok(workerMessages.some((message) => message.role === "user" && message.text === "" && message.attachments?.length === 2));
    const stopped = await tasks.create({ title: "Cancel during transfer", outcome: "Keep queued evidence", model: fixtureModel });
    await tasks.enqueue(stopped.id, "Stop before inference", randomUUID(), undefined, undefined, [file]);
    await tasks.dispatch(stopped.id, host, async () => ({ type: "spawned", binding }));
    const stoppedTask = await tasks.get(stopped.id); assert.ok(stoppedTask.worker.state === "bound");
    const controller = new AbortController(), calls = faux.state.callCount;
    await tasks.run({ type: "run_task", task_id: stopped.id, allocation_id: stoppedTask.worker.allocation_id, binding, instructions: "", model: fixtureModel, cwd: host.cwd },
      () => () => {}, [], async (command) => { const result = await call("stopped")(command); controller.abort(); return result; }, undefined,
      { signal: controller.signal, async ready() {}, answer() {}, idle() {} });
    assert.equal(faux.state.callCount, calls, "Detach during attachment preparation must not start inference");
    assert.equal((await tasks.get(stopped.id)).pending.length, 1);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
