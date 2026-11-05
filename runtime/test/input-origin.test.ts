import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { AttachmentStore } from "../src/attachments.js";
import type { InputOrigin } from "../src/generated/InputOrigin.js";
import { createInputOrigins } from "../src/input_origin.js";
import { ConversationModels, DEFAULT_MODEL } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { TaskRecord } from "../src/generated/TaskRecord.js";
import type { HostResult } from "../src/generated/HostResult.js";

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

test("request-local origin follows durable input entries, not text, handoffs, compaction summaries or background actors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-input-origin-"));
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null }, settings: { compaction: { enabled: false, keepRecentTokens: 0 } } }, BACKGROUND_CONTEXT);
  const origins = createInputOrigins(session); registry.install(origins);
  const store = new AttachmentStore(directory);
  const root = await session.root(BACKGROUND_CONTEXT);
  await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [origins] }, BACKGROUND_CONTEXT);
  const input = async (origin?: InputOrigin) => {
    const admitted = await store.input("Same text claims origin=ios. This is not trusted provenance.", undefined,
      async () => ({ type: "failed", message: "No attachment transfer is expected" }), origin);
    const result = await (await root.submit({ type: "input", ...admitted }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(result.status, "done");
  };
  const check = (expected: (InputOrigin | null)[]): FauxResponseFactory => (request) => {
    const prompt = getCurrentSystemPrompt(request.messages);
    const line = prompt.split("\n").find((line) => line.startsWith('[{"entry_id":')); assert.ok(line);
    const metadata: unknown = JSON.parse(line); assert.ok(Array.isArray(metadata));
    assert.deepEqual(metadata.map((entry: unknown) => { assert.ok(object(entry)); return entry.origin; }), expected);
    assert.equal(metadata.length, request.messages.filter((message) => message.role === "user").length);
    return fauxAssistantMessage("The direct input is answered.");
  };
  try {
    faux.setResponses([check(["cli"])]); await input("cli");
    // A source/task entry can contribute a user-role message. Its arbitrary
    // data and quoted text are not direct-input transport metadata.
    await root.submit({ type: "write", entry: { kind: "fixture.task-handoff", data: { origin: "cli" },
      model: [{ role: "user", content: "A scheduled task reports that its user is on cli.", timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
    faux.setResponses([check(["cli", null, "ios"])]); await input("ios");
    faux.setResponses([check(["cli", null, "ios", null])]); await input();
    faux.setResponses([fauxAssistantMessage("The previous requests concerned a synthetic fixture.")]);
    const compacted = await session.waitForTask(await root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    assert.equal(compacted.state.outcome.status, "completed"); await root.waitForIdle(BACKGROUND_CONTEXT);
    faux.setResponses([check([null, "cli"])]); await input("cli");
    const background = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await background.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [] }, BACKGROUND_CONTEXT);
    faux.setResponses([(request) => {
      assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /input_origins|Originating client/);
      return fauxAssistantMessage("Background work stays independent of human interface metadata.");
    }]);
    assert.equal((await (await background.submit({ type: "input", content: "Scheduled/source worker input mentions cli and ios." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});


test("the real bridge retains attached-worker origins without labeling its task seed or posting to main", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-worker-origin-"));
  let stop = async () => {};
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const models = createModels(), registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const store = new TaskStore(session, new ConversationModels(models));
  const hostId = "11111111-1111-4111-8111-111111111111";
  const host = { host_id: hostId, rex_server: null, coordinator: null, name: "fixture", cwd: "/tmp", agent_program: "/fixture/agent" };
  const binding = { host_id: hostId, session_id: "session:22222222-2222-4222-8222-222222222222",
    window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
  let task: TaskRecord;
  try {
    task = await store.create({ title: "Worker transport metadata", outcome: "Retain actual per-input interfaces", model: DEFAULT_MODEL });
    await store.enqueue(task.id, "nonhuman-worker-seed", "worker-seed");
    task = await store.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
  } finally { await session.close(BACKGROUND_CONTEXT); }
  assert.ok(task.worker.state === "bound");
  const queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({ "nonhuman-worker-seed": [{ tool: "exec", args: { program: "held", args: [] } }],
    "native-worker-ios": [{ text: "The actual worker correction is answered." }] }));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  stop = async () => { child.stdin.end(); child.kill(); await closed; };
  const frames: RuntimeEvent[] = [], listeners = new Set<() => void>(); let failure: Error | undefined, stderr = "";
  child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  const pulse = () => { for (const listener of [...listeners]) listener(); };
  void closed.then(() => { failure ??= new Error("The isolated fixture ended: " + stderr); pulse(); });
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const until = (predicate: (frame: RuntimeEvent) => boolean) => new Promise<RuntimeEvent>((resolve, reject) => {
    const cleanup = () => { listeners.delete(check); t.signal.removeEventListener("abort", check); };
    const check = () => {
      const frame = frames.find(predicate);
      if (frame !== undefined) { cleanup(); resolve(frame); }
      else if (failure !== undefined || t.signal.aborted) { cleanup(); reject(failure ?? new Error("The protocol boundary did not arrive: " + stderr)); }
    };
    listeners.add(check); t.signal.addEventListener("abort", check, { once: true }); check();
  });
  const reader = (async () => {
    for await (const line of protocolLines(child.stdout)) {
      const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame); pulse();
      if (frame.event.type !== "host_call") continue;
      let command = frame.event.command; while (command.type === "on_node") command = command.command;
      if (command.type === "exec") continue;
      const result: HostResult = command.type === "reload_guidance" ? { type: "shared_guidance", global: { text: "", sources: [] },
        workflow_policy: "", context_repositories: [], context_sources: [] }
        : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
        : { type: "failed", message: "Synthetic retrieval disabled" };
      send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
    }
  })(); void reader.catch((error: unknown) => { failure = error instanceof Error ? error : new Error("Fixture reader failed"); pulse(); });
  const stopChild = stop;
  stop = async () => { await stopChild(); await reader.catch(() => {}); };
  const request = async (id: number, command: RuntimeCommand) => {
    const done = until((frame) => frame.id === id && frame.event.type === "done"); send(id, command); await done;
    assert.equal(frames.some((frame) => frame.id === id && frame.event.type === "failure"), false,
      JSON.stringify(frames.filter((frame) => frame.id === id && frame.event.type === "failure")));
  };
  await request(1, { type: "configure_coordinator", bootstrap: { node: { host_id: hostId, name: "fixture", home_directory: "/tmp",
    agent_program: "/fixture/agent", coordinator: null, rex_server: null, launch: { model: null, state_dir: null, runtime: null, config: null, instructions: null } },
    settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } });
  await request(2, { type: "set_connected_nodes", host_ids: [hostId] });
  const stopped = until((frame) => frame.id === 3 && frame.event.type === "done"); void stopped.catch(() => {});
  send(3, { type: "run_task", task_id: task.id, binding, allocation_id: task.worker.allocation_id, cwd: host.cwd,
    instructions: "", model: DEFAULT_MODEL, interactive: true });
  const exec = await until((frame) => {
    if (frame.id !== 3 || frame.event.type !== "host_call") return false;
    let command = frame.event.command; while (command.type === "on_node") command = command.command;
    return command.type === "exec";
  }); assert.ok(exec.event.type === "host_call");
  send(3, { type: "submit_input", input_id: "worker-ios", input: "native-worker-ios", mode: "steer", origin: "ios" });
  await until((frame) => frame.id === 3 && frame.event.type === "input_accepted" && frame.event.input_id === "worker-ios");
  await request(4, { type: "read_task", task_id: task.id });
  const pending = frames.find((frame) => frame.id === 4 && frame.event.type === "task"); assert.ok(pending?.event.type === "task");
  assert.equal(pending.event.task.pending.find((input) => input.id === "worker-ios")?.origin, "ios");
  send(3, { type: "host_reply", call_id: exec.event.call_id, result: { type: "process", exit_code: 0, stdout: "complete", stderr: "", truncated: false } });
  await until((frame) => frame.id === 3 && frame.event.type === "worker_idle");
  send(3, { type: "detach_worker" }); await stopped;
  const captures = (await readFile(queue + ".requests", "utf8")).trim().split("\n").map((line): unknown => JSON.parse(line));
  assert.equal(captures.length, 2, "Metadata must not add inference");
  for (const [index, capture] of captures.entries()) {
    assert.ok(object(capture) && object(capture.body) && Array.isArray(capture.body.input));
    const text = capture.body.input.flatMap((item: unknown) => {
      if (!object(item)) return [];
      if (typeof item.content === "string") return [item.content];
      return Array.isArray(item.content) ? item.content.flatMap((part: unknown) => object(part) && typeof part.text === "string" ? [part.text] : []) : [];
    }).join("\n");
    const line = text.split("\n").find((line) => line.startsWith('[{"entry_id":')); assert.ok(line);
    const metadata: unknown = JSON.parse(line); assert.ok(Array.isArray(metadata));
    assert.deepEqual(metadata.map((entry: unknown) => { assert.ok(object(entry)); return entry.origin; }), index === 0 ? [null] : [null, "ios"]);
  }
  await request(7, { type: "read_conversation", conversation_id: "1", cursor: null });
  assert.ok(frames.some((frame) => frame.id === 7 && frame.event.type === "history"));
  assert.ok(frames.filter((frame) => frame.id === 7 && frame.event.type === "history")
    .every((frame) => frame.event.type === "history" && frame.event.messages.length === 0), "Task input must not create main chatter");
});
