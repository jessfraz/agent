import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ConversationModels, DEFAULT_MODEL } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { HostResult } from "../src/generated/HostResult.js";
import { fixtureModel } from "./model.js";

test("attached worker admits native steering before the current tool finishes and queues a separate turn", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-native-steer-")); const registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null }, settings: { steeringMode: "all", followUpMode: "one-at-a-time" } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models)), executions = new Executions(), tools = createAppTools(tasks, executions);
  registry.install(tools.host); const controller = new AbortController(); const answers: string[] = [];
  let release = () => {}, started = () => {}, idle = () => {}; let running: Promise<unknown> | undefined;
  const held = new Promise<HostResult>((resolve) => { release = () => resolve({ type: "process", exit_code: 0, stdout: "complete", stderr: "", truncated: false }); });
  let effect = held, effects = 0; const rejected: string[] = [];
  const entered = new Promise<void>((resolve) => { started = resolve; }), finished = new Promise<void>((resolve) => { idle = resolve; });
  const host = { host_id: null, rex_server: null, coordinator: null, name: "fixture", cwd: "/tmp", agent_program: "/fixture/agent" };
  const binding = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
    window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
  try {
    const task = await tasks.create({ title: "Native steering", outcome: "Use the correction", model: fixtureModel });
    await tasks.enqueue(task.id, "Original instruction", "original"); await tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await tasks.get(task.id); assert.ok(saved.worker.state === "bound");
    const command: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id, binding,
      allocation_id: saved.worker.allocation_id, cwd: host.cwd, instructions: "", model: fixtureModel, interactive: true };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("exec", { program: "held", args: [] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Steered result"), fauxAssistantMessage("Queued result"), fauxAssistantMessage("Second queued result")]);
    const observer = { signal: controller.signal, async ready() {}, answer(_id: string, text: string) { answers.push(text); },
      idle() { idle(); }, rejected(id: string) { rejected.push(id); } };
    running = tasks.run(command, (conversation) => executions.bind(conversation.id.toString(), { cwd: host.cwd, hosts: [],
      call: async () => { effects += 1; started(); return effect; } }), [tools.host], undefined, undefined, observer);
    await entered;
    const submit: (input: typeof command, text: string, id: string, mode: "steer" | "follow_up") => ReturnType<TaskStore["input"]> = tasks.input.bind(tasks);
    await submit(command, "Next turn only", "queued", "follow_up");
    await submit(command, "Refine the next turn", "queued-second", "follow_up");
    await submit(command, "Correct the current tool work", "steered", "steer");
    await submit(command, "Only test things that matter", "steered-second", "steer");
    const conversation = await tasks.conversation(task.conversation_id);
    const steered = await session.commit((tx) => tx.submissionByRequest(conversation.id, "steered"), BACKGROUND_CONTEXT);
    assert.ok(steered, "Steering must enter Pi before the current tool is released");
    const queued = await session.commit((tx) => tx.submissionByRequest(conversation.id, "queued"), BACKGROUND_CONTEXT); assert.ok(queued);
    assert.equal(steered.status, "queued"); assert.equal(queued.status, "queued");
    release(); await finished;
    assert.deepEqual(answers, ["Steered result", "Queued result", "Second queued result"],
      "Steers share the active answer; queued inputs get separate FIFO turns");
    assert.deepEqual((await tasks.get(task.id)).pending, []);
    assert.equal((await session.commit((tx) => tx.submissionByRequest(conversation.id, "steered"), BACKGROUND_CONTEXT))?.answer,
      (await session.commit((tx) => tx.submissionByRequest(conversation.id, "original"), BACKGROUND_CONTEXT))?.answer);
    assert.equal((await session.commit((tx) => tx.submissionByRequest(conversation.id, "steered-second"), BACKGROUND_CONTEXT))?.answer,
      (await session.commit((tx) => tx.submissionByRequest(conversation.id, "steered"), BACKGROUND_CONTEXT))?.answer);
    assert.notEqual((await session.commit((tx) => tx.submissionByRequest(conversation.id, "queued-second"), BACKGROUND_CONTEXT))?.answer,
      (await session.commit((tx) => tx.submissionByRequest(conversation.id, "queued"), BACKGROUND_CONTEXT))?.answer);
    assert.equal(effects, 1, "Refining an active run must not repeat its completed tool operation");
    const visible = (await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items
      .flatMap((entry) => entry.model ?? []).flatMap((message) => message.role === "user" && typeof message.content === "string" ? [message.content] : []);
    for (const content of ["Original instruction", "Next turn only", "Refine the next turn", "Correct the current tool work", "Only test things that matter"]) {
      assert.equal(visible.filter((value) => value === content).length, 1, "Burst messages remain distinct durable user entries");
    }
    const stopped = new Promise<void>((resolve) => { idle = resolve; });
    const cancelling = new Promise<void>((resolve) => { started = resolve; });
    effect = new Promise<HostResult>((resolve) => { release = () => resolve({ type: "process", exit_code: 0, stdout: "stopped", stderr: "", truncated: false }); });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("exec", { program: "held", args: [] }), { stopReason: "toolUse" })]);
    await submit(command, "Start work to stop", "stop-current", "steer"); await cancelling;
    await submit(command, "Do not silently run this after stop", "stop-queued", "follow_up");
    const callsBeforeStop = faux.state.callCount; const aborting = conversation.abort(BACKGROUND_CONTEXT); release(); await aborting; await stopped;
    assert.ok(rejected.includes("stop-queued")); assert.equal(faux.state.callCount, callsBeforeStop);
    assert.deepEqual((await tasks.get(task.id)).pending, []);
    const detaching = new Promise<void>((resolve) => { started = resolve; });
    effect = new Promise<HostResult>((resolve) => { release = () => resolve({ type: "process", exit_code: 0, stdout: "drained", stderr: "", truncated: false }); });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("exec", { program: "held", args: [] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Final answer before detach"), fauxAssistantMessage(fauxToolCall("exec", { program: "held", args: [] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Queued answer after detach")]);
    await submit(command, "Start the detach case", "detach-current", "steer"); await detaching;
    await submit(command, "Keep accepted follow-up owned", "detach-queued", "follow_up");
    await submit(command, "Refine the held detach turn", "detach-steer", "steer");
    const beforeDetach = effects; controller.abort(); release(); await running; running = undefined;
    assert.equal(effects, beforeDetach + 1, "An already-admitted native follow-up keeps its execution binding while detached work drains");
    assert.deepEqual((await tasks.get(task.id)).pending.map((input) => input.id), ["detach-queued", "detach-steer"]);
    const beforeRecovery = faux.state.callCount;
    const recovered = await tasks.run({ ...command, interactive: false }, () => () => {});
    assert.equal(recovered.text, "Queued answer after detach"); assert.equal(faux.state.callCount, beforeRecovery);
    assert.deepEqual((await tasks.get(task.id)).pending, []);
  } finally { release(); controller.abort(); await running?.catch(() => {}); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("main native steering keeps the execution lease until queued inputs finish and emits each answer once", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-steer-")), queue = join(directory, "responses.json");
  const originalInput = "original-main " + "Native Unicode 🦀 input. ".repeat(500);
  await writeFile(queue, JSON.stringify({ "original-main": [{ tool: "exec", args: { program: "held", args: [] } }],
    "current-correction": [{ text: "Steered result" }], "next-followup first": [{ text: "Queued first result" }],
    "next-followup second": [{ text: "Queued second result" }] }));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve)); const frames: RuntimeEventKind[] = [];
  let held: { request: number; call: string } | undefined, entered = () => {}; const began = new Promise<void>((resolve) => { entered = resolve; });
  const waiters = new Map<number, () => void>(); const controls: string[] = [];
  let accepted = () => {}, expectedControls = 4; const admitted = new Promise<void>((resolve) => { accepted = resolve; });
  const send = (id: number, command: unknown) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const done = (id: number) => new Promise<void>((resolve) => { waiters.set(id, resolve); });
  let errors = ""; child.stderr.setEncoding("utf8").on("data", (value: string) => { errors += value; });
  const reader = (async () => {
    for await (const line of protocolLines(child.stdout)) {
      const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); assert.notEqual(frame.id, 0, "Active input controls must not create an unowned protocol request");
      frames.push(frame.event);
      if (frame.event.type === "done") waiters.get(frame.id)?.();
      const kind: string = frame.event.type;
      if (kind === "input_accepted" && "input_id" in frame.event && typeof frame.event.input_id === "string") {
        controls.push(frame.event.input_id); if (controls.length >= expectedControls) accepted();
      }
      if (frame.event.type === "host_cancel" && held?.call === frame.event.call_id) {
        send(held.request, { type: "host_reply", call_id: held.call, result: { type: "process", exit_code: 143, stdout: "", stderr: "cancelled", truncated: false } });
      }
      if (frame.event.type !== "host_call") continue;
      let command = frame.event.command; while (command.type === "on_node") command = command.command;
      if (command.type === "exec") { held = { request: frame.id, call: frame.event.call_id }; entered(); continue; }
      const result: HostResult = command.type === "reload_guidance" ? { type: "shared_guidance", global: { text: "", sources: [] },
        workflow_policy: "", context_repositories: [], context_sources: [] }
        : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
        : { type: "failed", message: "Synthetic retrieval disabled" };
      send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
    }
  })(); void reader.catch(() => {});
  try {
    const host = "11111111-1111-4111-8111-111111111111";
    const configured = done(1); send(1, { type: "configure_coordinator", bootstrap: { node: { host_id: host, name: "fixture", home_directory: "/tmp",
      agent_program: "/fixture/agent", coordinator: null, rex_server: null, launch: { model: null, state_dir: null, runtime: null, config: null, instructions: null } },
      settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } }); await configured;
    const connected = done(20); send(20, { type: "set_connected_nodes", host_ids: [host] }); await connected;
    const complete = done(2); send(2, { type: "chat", input: originalInput, instructions: "", model: null, cwd: "/tmp", origin_host_id: null, hosts: [] });
    // Controls can arrive before initial retrieval/configuration finishes.
    send(2, { type: "submit_input", input_id: "queue", input: "next-followup first", mode: "follow_up" });
    send(2, { type: "submit_input", input_id: "queue-second", input: "next-followup second", mode: "follow_up" });
    send(2, { type: "submit_input", input_id: "steer", input: "current-correction first", mode: "steer" });
    send(2, { type: "submit_input", input_id: "steer-second", input: "current-correction second", mode: "steer" });
    await Promise.race([began, reader, complete.then(() => { throw new Error("The native turn ended before its held tool started"); })]); assert.ok(held);
    await Promise.race([admitted, reader]);
    send(held.request, { type: "host_reply", call_id: held.call, result: { type: "process", exit_code: 0, stdout: "complete", stderr: "", truncated: false } });
    await Promise.race([complete, reader]);
    assert.deepEqual(frames.flatMap((event) => event.type === "answer" ? [event.text] : []),
      ["Steered result", "Queued first result", "Queued second result"]);
    const users = new Map<string, string>(); let continuations = 0;
    for (const event of frames) {
      if (event.type !== "message" || event.message.role !== "user") continue;
      const message = event.message;
      if (message.continuation) { continuations += 1; assert.ok(users.has(message.entry_id)); }
      else { assert.equal(users.has(message.entry_id), false, "Each actual user entry is emitted once"); users.set(message.entry_id, ""); }
      users.set(message.entry_id, users.get(message.entry_id) + message.text);
    }
    assert.equal(users.size, 5, "Main must emit its initial input, both steers and both queued inputs");
    assert.deepEqual([...users.values()], [originalInput, "current-correction first", "current-correction second", "next-followup first", "next-followup second"],
      "Main must deliver initial, steered and queued originals as distinct canonical user entries");
    assert.ok(continuations > 0, "The actual native transcript producer must preserve a large multi-frame original");
    assert.equal(frames.at(-1)?.type, "done");
    await writeFile(queue, JSON.stringify({ "stop-main": [{ tool: "exec", args: { program: "held", args: [] } }], "never-run": [{ text: "Must not execute" }],
      "fresh-main": [{ text: "Fresh work after stop" }] }));
    const stopping = new Promise<void>((resolve) => { entered = resolve; }); held = undefined;
    const stopped = done(3); send(3, { type: "chat", input: "stop-main", instructions: "", model: null, cwd: "/tmp", origin_host_id: null, hosts: [] });
    await Promise.race([stopping, reader]); assert.ok(held);
    expectedControls = 5; const queued = new Promise<void>((resolve) => { accepted = resolve; });
    send(3, { type: "submit_input", input_id: "stopped-queue", input: "never-run", mode: "follow_up" }); await Promise.race([queued, reader]);
    send(3, { type: "interrupt" }); await Promise.race([stopped, reader]);
    assert.ok(frames.some((event) => event.type === "input_rejected" && event.input_id === "stopped-queue"));
    assert.equal(frames.some((event) => event.type === "answer" && event.text === "Must not execute"), false);
    const fresh = done(4); send(4, { type: "chat", input: "fresh-main", instructions: "", model: null, cwd: "/tmp", origin_host_id: null, hosts: [] });
    await Promise.race([fresh, reader]); assert.ok(frames.some((event) => event.type === "answer" && event.text === "Fresh work after stop"));
    child.stdin.end(); assert.equal(await closed, 0, errors); await reader;
  } finally { child.kill(); await closed; await reader.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
