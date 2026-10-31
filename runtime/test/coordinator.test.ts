import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createConnection } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validEvent } from "../src/protocol.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { TaskRecord } from "../src/generated/TaskRecord.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import { sessions } from "./fixtures/coordinator-native.js";
import type { ModelQueue, ModelStep } from "./fixtures/coordinator-runtime.js";

test("real CLI, coordinator and worker retain main history across an offline laptop and route restored work", { timeout: 60_000 }, async (t) => {
  const directory = await realpath(await mkdtemp("/tmp/agent-e2e-"));
  const binary = process.env.AGENT_TEST_BINARY ?? fileURLToPath(new URL("../../../target/debug/beep-boop", import.meta.url));
  const terminalFixture = fileURLToPath(new URL("../../../target/debug/examples/terminal-fixture", import.meta.url));
  const runtime = fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url));
  const coordinator = "11111111-1111-4111-8111-111111111111", laptop = "22222222-2222-4222-8222-222222222222";
  const bin = join(directory, "bin"), queue = join(directory, "responses.json"), feedbackGate = join(directory, "feedback-gate");
  const homes = [join(directory, "desktop"), join(directory, "laptop")];
  const socket = join(homes[0]!, "state", "agent.sock");
  const children: { child: ChildProcessWithoutNullStreams; exited: Promise<number | null>; output: () => string; errors: () => string }[] = [];
  const events = (text: string): RuntimeEventKind[] => text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => {
    const event: unknown = JSON.parse(line), frame = { version: 1, id: 1, event };
    assert.ok(validEvent(frame), "The real CLI must return typed protocol events"); return frame.event;
  });
  function start(host: number, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}, nativeArguments = false, terminal = false,
    clientBinary = binary) {
    const home = homes[host]; assert.ok(home);
    const arguments_ = nativeArguments ? args : ["--state-dir", join(home, "state"), "--config", join(home, "agent.toml"),
      "--runtime", runtime, "--instructions", join(home, "AGENTS.md"), ...args];
    const command = terminal ? [clientBinary, ...arguments_]
      : ["--json", "--no-tui", ...arguments_];
    const child = spawn(terminal ? terminalFixture : clientBinary, command, { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: bin + delimiter + process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local"),
      TMPDIR: directory, TERM: "xterm-256color", AGENT_SQLITE_VEC: process.env.AGENT_SQLITE_VEC, OPENAI_API_KEY: "sk-synthetic-fixture",
      AGENT_TEST_NODE_ID: host === 0 ? coordinator : laptop, AGENT_TEST_REX_STATE: join(home, "rex.json"),
      AGENT_TEST_MODEL_QUEUE: queue, AGENT_TEST_COORDINATOR_SOCKET: socket, AGENT_TEST_FEEDBACK_GATE: feedbackGate, ...extra,
      ...(terminal ? { AGENT_TEST_TERMINAL_REPLY: "1" } : {}),
    } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const owned = { child, exited, output: () => stdout, errors: () => stderr }; children.push(owned);
    if (input !== undefined) {
      if (input.length === 0) child.stdin.end();
      else child.stdin.end(input);
    }
    return owned;
  }
  async function cli(host: number, args: string[], input = "", clientBinary = binary) {
    const process = start(host, args, input, {}, false, false, clientBinary); assert.equal(await process.exited, 0, process.errors()); return events(process.output());
  }
  async function exchange(command: RuntimeCommand, observe?: (event: RuntimeEventKind) => void): Promise<RuntimeEventKind[]> {
    const channel = createConnection(socket); let output = "", done = false, observed = 0;
    try {
      return await new Promise<RuntimeEventKind[]>((resolve, reject) => {
        channel.on("error", reject).on("data", (bytes: Buffer) => {
          try {
            output += bytes.toString("utf8"); const frames = events(output);
            for (const frame of frames.slice(observed)) observe?.(frame); observed = frames.length;
            if (frames.some((frame) => frame.type === "done")) { done = true; resolve(frames); }
          } catch (error) { reject(error); }
        }).on("end", () => { if (!done) reject(new Error("The coordinator closed a main view before Done")); });
        channel.write(JSON.stringify(command) + "\n");
      });
    } finally { channel.destroy(); }
  }
  async function until(check: () => Promise<boolean>, message = "", diagnostic: () => string = () => ""): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!await check()) { assert.ok(Date.now() < deadline, message + "\n" + diagnostic() + "\n" + children.map((process) => process.errors()).join("\n") +
      children.slice(-3).map((process) => process.output().slice(-2400)).join("\n")); await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  async function online(ids: string[]): Promise<void> {
    await until(async () => {
      const state = (await cli(0, ["nodes"])).find((event) => event.type === "environment");
      return state?.type === "environment" && state.online_host_ids.slice().sort().join() === ids.slice().sort().join();
    });
  }
  async function tasks() {
    const event = (await cli(0, ["tasks", "list"])).find((event) => event.type === "tasks"); assert.ok(event?.type === "tasks"); return event.tasks;
  }
  async function script(key: string, steps: ModelStep[]): Promise<void> {
    const current: ModelQueue = JSON.parse(await readFile(queue, "utf8")); current[key] = steps; await writeFile(queue, JSON.stringify(current));
  }
  const effect = ["-e", "const value={host:process.env.AGENT_TEST_NODE_ID,cwd:process.cwd()};require('node:fs').appendFileSync(process.env.HOME+'/effects',JSON.stringify(value)+'\\n');process.stdout.write(JSON.stringify(value))"];
  const exec: ModelStep = { tool: "exec", args: { program: process.execPath, args: effect } };
  const delegate = (title: string, host?: string): ModelStep => ({ tool: "delegate_task", args: { title, outcome: title, input: title, new_task: true,
    new_task_reason: `${title} is a separate synthetic audit.`,
    ...(host === undefined ? {} : { host }) } });
  try {
    await mkdir(bin); await writeFile(queue, "{}");
    for (const method of ["rex", "ssh"]) {
      const path = join(bin, method); await writeFile(path, `#!${process.execPath}\nprocess.env.AGENT_TEST_NATIVE=${JSON.stringify(method)};await import(${JSON.stringify(new URL("./fixtures/coordinator-native.js", import.meta.url).href)});\n`); await chmod(path, 0o700);
    }
    for (const [index, home] of homes.entries()) {
      await mkdir(join(home, "state"), { recursive: true, mode: 0o700 }); await chmod(join(home, "state"), 0o700);
      await writeFile(join(home, "AGENTS.md"), "Keep synthetic work on its requested host.\n");
      await writeFile(join(home, "agent.toml"), `node_name = "${index === 0 ? "desktop" : "laptop"}"\n` +
        (index === 0 ? "" : "coordinator = \"synthetic-coordinator\"\n"));
    }
    const server = start(0, ["serve", "--local-only", "--no-sources"]);
    await until(async () => { try { return (await stat(socket)).isSocket(); } catch { return false; } });
    let worker = start(1, ["maintain"]); await online([coordinator, laptop]);
    await script("fixture-initial-main", [exec, delegate("fixture-initial-worker", laptop), delegate("Initial desktop audit"), { text: "Sapphire main detail retained." }]);
    const first = (await cli(1, ["chat", "fixture-initial-main: remember the sapphire connector."], "", process.env.AGENT_TEST_LEGACY_CHAT_BINARY ?? binary)).find((event) => event.type === "answer"); assert.ok(first?.type === "answer");
    const chiefConversationId = first.conversation_id;
    const old = (await tasks()).find((task) => task.title === "fixture-initial-worker"); assert.ok(old?.worker.state === "bound");
    const original = old.worker, launch = sessions(join(homes[1]!, "rex.json")).find((session) => session.session_id === original.binding.session_id); assert.ok(launch);
    const run = () => start(1, launch.command.slice(1), undefined, { REX_SESSION: launch.session_id, REX_BLOCK: launch.block_id }, true);
    await script("fixture-initial-worker", [exec,
      { tool: "exec", args: { program: process.execPath, args: effect, host: coordinator } },
      { tool: "exec", args: { program: process.execPath, args: effect, host: "laptop" } },
      { tool: "exec", args: { program: process.execPath, args: effect, host: "missing-host" } },
      { text: "Sapphire laptop measurement retained." }]);
    let actor = run(); await until(async () => events(actor.output()).some((event) => event.type === "worker_idle"));
    const initialWorker = events(actor.output());
    const readyIndex = initialWorker.findIndex((event) => event.type === "task_ready");
    const idleIndex = initialWorker.findIndex((event) => event.type === "worker_idle");
    const page = initialWorker.slice(readyIndex + 1, idleIndex).filter((event) => event.type === "history");
    assert.ok(readyIndex >= 0 && idleIndex > readyIndex && page.length > 0);
    assert.equal(page.at(-1)?.page_complete, true, "A live RunTask must complete its history page before idle without ending the session");
    assert.equal(initialWorker.slice(0, idleIndex + 1).some((event) => event.type === "done"), false);
    actor.child.stdin.end("/exit\n"); assert.equal(await actor.exited, 0, actor.errors());
    const taskSettings = (await exchange({ type: "conversation_settings", task_id: old.id, agent_id: null,
      change: { type: "set_reasoning", reasoning: "high" }, catalog: false })).find((event) => event.type === "conversation_settings");
    assert.ok(taskSettings?.type === "conversation_settings"); assert.equal(taskSettings.settings.model.reasoning, "high");
    worker.child.kill("SIGINT"); assert.equal(await worker.exited, 0, worker.errors()); await online([coordinator]);
    const retained = (await tasks()).find((task) => task.id === old.id); assert.ok(retained);
    await script("fixture-offline-main", [{ tool: "read_task", args: { task_id: old.id } }, exec, delegate("Offline desktop audit"),
      delegate("Rejected offline laptop work", laptop), { text: "Offline desktop work complete." }]);
    const offline = (await cli(0, ["chat", "fixture-offline-main: inspect the old laptop details and do new work here."])).find((event) => event.type === "answer"); assert.ok(offline?.type === "answer");
    assert.equal(offline.conversation_id, first.conversation_id); assert.deepEqual((await tasks()).find((task) => task.id === old.id), retained);
    const history = (await cli(0, [], "/exit\n")).find((event) => event.type === "history"); assert.ok(history?.type === "history");
    assert.equal(history.conversation_id, first.conversation_id); assert.ok(history.messages.some((message) => message.text === "Sapphire main detail retained."));
    worker = start(1, ["maintain"]); await online([coordinator, laptop]); actor = run();
    await until(async () => events(actor.output()).some((event) => event.type === "worker_idle"));
    const reopenedSettings = events(actor.output()).find((event) => event.type === "conversation_settings");
    assert.ok(reopenedSettings?.type === "conversation_settings", "A resumed worker must announce its actual persisted model instead of its old launch arguments");
    assert.equal(reopenedSettings.settings.conversation_id, old.conversation_id); assert.equal(reopenedSettings.settings.model.reasoning, "high");
    await script("fixture-worker-followup", [{ text: "Retained laptop session continued." }]);
    await script("fixture-restored-main", [exec, { tool: "exec", args: { program: process.execPath, args: effect, host: laptop } },
      delegate("Restored desktop audit"), delegate("Restored laptop audit", laptop),
      { tool: "delegate_task", args: { task_id: old.id, input: "fixture-worker-followup" } }, { text: "Restored routing complete." }]);
    const restored = (await cli(0, ["chat", "fixture-restored-main: use the connected laptop for explicit work."])).find((event) => event.type === "answer"); assert.ok(restored?.type === "answer");
    assert.equal(restored.conversation_id, first.conversation_id);
    await until(async () => events(actor.output()).some((event) => event.type === "answer" && event.text === "Retained laptop session continued."));
    const all = await tasks(), continued = all.find((task) => task.id === old.id); assert.ok(continued?.worker.state === "bound");
    assert.deepEqual(continued.worker.binding, original.binding); assert.equal(continued.worker.allocation_id, original.allocation_id); assert.equal(continued.conversation_id, old.conversation_id);
    assert.equal(all.length, 5);
    for (const title of ["Initial desktop audit", "Offline desktop audit", "Restored desktop audit"]) {
      const task = all.find((task) => task.title === title); assert.ok(task?.worker.state === "bound"); assert.equal(task.worker.binding.host_id, coordinator);
    }
    assert.equal(sessions(join(homes[1]!, "rex.json")).length, 2, "Continuing the original task must not create another Rex session");
    for (const [index, host, count] of [[0, coordinator, 4], [1, laptop, 3]] satisfies [number, string, number][]) {
      const effects: unknown[] = (await readFile(join(homes[index]!, "effects"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(effects, Array.from({ length: count }, () => ({ host, cwd: homes[index] })),
        "Explicit worker commands must reach their registered host while ordinary commands keep the task's owning host");
    }
    const requests: unknown[] = (await readFile(queue + ".requests", "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const workerRequest = requests.find((request) => request !== null && typeof request === "object" &&
      "key" in request && request.key === "fixture-initial-worker");
    assert.ok(workerRequest !== null && typeof workerRequest === "object" && "body" in workerRequest);
    const workerContext = JSON.stringify(workerRequest.body);
    assert.ok(workerContext.includes("Connected worker hosts:") && workerContext.includes(coordinator) && workerContext.includes(laptop),
      "The worker's first model request must describe the same connected host registry used for explicit commands");
    let readEvidence = false;
    for (const request of requests) {
      if (request === null || typeof request !== "object" || !("key" in request) || request.key !== "fixture-offline-main") continue;
      assert.ok("body" in request && request.body !== null && typeof request.body === "object" && "input" in request.body && Array.isArray(request.body.input));
      const calls = new Set(request.body.input.flatMap((item: unknown) => item !== null && typeof item === "object" && "type" in item && item.type === "function_call" &&
        "name" in item && item.name === "read_task" && "call_id" in item && typeof item.call_id === "string" ? [item.call_id] : []));
      for (const item of request.body.input) {
        if (item === null || typeof item !== "object" || !("type" in item) || item.type !== "function_call_output" ||
          !("call_id" in item) || typeof item.call_id !== "string" || !calls.has(item.call_id) || !("output" in item)) continue;
        const evidence = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
        assert.ok(evidence.includes("Sapphire laptop measurement retained.")); readEvidence = true;
      }
    }
    assert.ok(readEvidence, "The real read_task result must deliver offline worker evidence back to the model");
    await writeFile(feedbackGate, "hold the independent feedback admission");
    actor.child.stdin.write("/feedback fixture-feedback-first: preserve the existing task folder.\n");
    const reports = () => events(actor.output()).filter((event) => event.type === "feedback_ready");
    await until(async () => stat(feedbackGate + ".entered").then(() => true, () => false));
    assert.equal(reports().length, 0, "The fixture must hold the actual native feedback admission");
    await script("fixture-original-during-feedback", [{ text: "The original task accepted input while feedback admission was held." }]);
    actor.child.stdin.write("fixture-original-during-feedback\n");
    await until(async () => events(actor.output()).some((event) => event.type === "answer" &&
      event.conversation_id === old.conversation_id && event.text === "The original task accepted input while feedback admission was held."),
    "The original worker must keep processing input while feedback admission waits");
    assert.equal(reports().length, 0, "Processing the original task must not depend on receiving the feedback receipt");
    await rm(feedbackGate);
    await until(async () => reports().length === 1);
    const firstReport = reports()[0]; assert.ok(firstReport);
    const captured = (await cli(0, ["feedback", "show", firstReport.receipt.id])).find((event) => event.type === "feedback");
    assert.ok(captured?.type === "feedback");
    assert.equal(captured.bundle.context.origin_host_id, laptop); assert.equal(captured.bundle.context.task_id, old.id);
    assert.equal(captured.bundle.context.conversation_id, old.conversation_id); assert.deepEqual(captured.bundle.context.binding, original.binding);
    assert.equal((await stat(firstReport.receipt.path)).mode & 0o077, 0, "The coordinator must retain feedback privately");
    const repair = (await tasks()).find((task) => task.id === firstReport.receipt.task_id); assert.ok(repair?.worker.state === "bound");
    const repairBinding = repair.worker.binding;
    assert.notEqual(repair.id, old.id); assert.equal(repair.worker.binding.host_id, laptop);
    assert.equal(repair.worker.binding.session_id, original.binding.session_id); assert.notEqual(repair.worker.binding.window_id, original.binding.window_id);
    const repairLaunch = sessions(join(homes[1]!, "rex.json")).find((window) => window.block_id === repairBinding.block_id); assert.ok(repairLaunch);
    assert.equal(repairLaunch.label, "Beep Boop feedback");
    await script("fixture-feedback-first", [{ text: "The feedback repair is verified and remains in the existing folder." }]);
    const repairActor = start(1, repairLaunch.command.slice(1), undefined,
      { REX_SESSION: repairLaunch.session_id, REX_BLOCK: repairLaunch.block_id }, true);
    await until(async () => events(repairActor.output()).some((event) => event.type === "worker_idle"));
    const repairFinal = "The feedback repair is verified and remains in the existing folder.";
    assert.equal(events(repairActor.output()).filter((event) => event.type === "answer" && event.text === repairFinal).length, 1);
    const repairHistory = await exchange({ type: "read_history", task_id: repair.id, agent_id: null, cursor: null });
    assert.equal(repairHistory.flatMap((event) => event.type === "history" ? event.messages : [])
      .filter((message) => message.text === repairFinal).length, 1);
    assert.equal((await cli(0, [], "/exit\n")).some((event) => event.type === "history" &&
      event.conversation_id === first.conversation_id && event.messages.some((message) => message.text === repairFinal)), false);
    await script("fixture-feedback-again", [{ text: "The additional feedback was checked in the same repair conversation." }]);
    actor.child.stdin.write("/feedback fixture-feedback-again: keep the queued correction too.\n");
    await until(async () => reports().length === 2);
    const secondReport = reports()[1]; assert.ok(secondReport);
    assert.notEqual(secondReport.receipt.id, firstReport.receipt.id); assert.equal(secondReport.receipt.task_id, repair.id);
    await until(async () => events(repairActor.output()).some((event) => event.type === "answer" &&
      event.conversation_id === repair.conversation_id && event.text === "The additional feedback was checked in the same repair conversation."));
    const repaired = (await tasks()).find((task) => task.id === repair.id); assert.ok(repaired?.worker.state === "bound");
    assert.deepEqual(repaired.worker.binding, repairBinding);
    const windows = sessions(join(homes[1]!, "rex.json"));
    assert.equal(new Set(windows.map((window) => window.session_id)).size, 2, "Feedback must not create a top-level Rex folder");
    assert.equal(windows.filter((window) => window.session_id === original.binding.session_id).length, 2, "Repeated feedback must reuse its repair terminal");
    await script("fixture-original-after-feedback", [{ text: "The original task remains usable after both feedback reports." }]);
    actor.child.stdin.write("fixture-original-after-feedback\n");
    await until(async () => events(actor.output()).some((event) => event.type === "answer" &&
      event.conversation_id === old.conversation_id && event.text === "The original task remains usable after both feedback reports."));
    const originalAfterFeedback = (await tasks()).find((task) => task.id === old.id); assert.ok(originalAfterFeedback?.worker.state === "bound");
    assert.deepEqual(originalAfterFeedback.worker.binding, original.binding);

    // A native PTY exercises the same key and slash-command paths as an actual
    // terminal. The held process belongs to the coordinator, not this client.
    const held = (path: string): ModelStep => ({ tool: "exec", args: { program: process.execPath, args: ["-e",
      'const fs=require("node:fs"),path=process.argv[1];fs.writeFileSync(path+".started",String(process.pid));' +
      'async function run(){while(!fs.existsSync(path+".release"))await new Promise(resolve=>setTimeout(resolve,20));' +
      'fs.appendFileSync(path+".finished","once\\n");process.stdout.write("Completed the held action.");}void run();', path] } });
    async function mainHistory() {
      const frame = (await cli(0, [], "/exit\n")).find((event) => event.type === "history");
      assert.ok(frame?.type === "history"); assert.equal(frame.conversation_id, chiefConversationId); return frame;
    }
    await t.test("held worker effects do not serialize main admission, another task or peer controls", async () => {
      const firstPath = join(directory, "parallel-first"), secondPath = join(directory, "parallel-second");
      const firstInput = "fixture-parallel-first", secondInput = "fixture-parallel-second";
      const firstAnswer = "The first parallel task finished.", secondAnswer = "The second parallel task finished.";
      await script(firstInput, [held(firstPath), { text: firstAnswer }]);
      await script("fixture-parallel-dispatch-first", [{ tool: "delegate_task", args: { task_id: old.id, input: firstInput } },
        { text: "The first task owns its separate worker." }]);
      await cli(0, ["chat", "fixture-parallel-dispatch-first"]);
      await until(async () => stat(firstPath + ".started").then(() => true, () => false));
      const before = await tasks(), receipts: RuntimeEventKind[] = [];
      await script(secondInput, [held(secondPath), { text: secondAnswer }]);
      await script("fixture-parallel-dispatch-second", [delegate(secondInput, coordinator), { text: "The second task owns its separate worker." }]);
      const input: RuntimeCommand = { type: "conversation_input", conversation_id: chiefConversationId,
        input_id: "parallel-main-input", input: "fixture-parallel-dispatch-second", mode: "steer" };
      const admission = exchange(input, (event) => { receipts.push(event); }); void admission.catch(() => {});
      await until(async () => receipts.some((event) => event.type === "done"),
        "Main admission and delegation must finish independently of the held worker");
      const admitted = await admission;
      assert.ok(receipts.some((event) => event.type === "input_accepted" && event.input_id === input.input_id));
      assert.equal(await stat(firstPath + ".finished").then(() => true, () => false), false,
        "The main request must finish delegating while the first worker's host effect remains held");
      const repeated = await exchange(input);
      assert.deepEqual(repeated.find((event) => event.type === "input_placed"), admitted.find((event) => event.type === "input_placed"),
        "Retrying one main input must return its original durable placement");
      const second = (await tasks()).find((task) => task.title === secondInput); assert.ok(second?.worker.state === "bound");
      const binding = second.worker.binding;
      assert.notEqual(binding.session_id, original.binding.session_id);
      assert.equal(binding.host_id, coordinator);
      const launch = sessions(join(homes[0]!, "rex.json")).find((window) => window.block_id === binding.block_id); assert.ok(launch);
      const parallel = start(0, launch.command.slice(1), undefined, { REX_SESSION: launch.session_id, REX_BLOCK: launch.block_id }, true);
      await until(async () => stat(secondPath + ".started").then(() => true, () => false),
        "The second task must start its real host effect before the first finishes");
      const peerInput = "fixture-parallel-peer", peerAnswer = "The other worker remains responsive while both effects wait.";
      await script(peerInput, [{ text: peerAnswer }]); repairActor.child.stdin.write(peerInput + "\n");
      await until(async () => events(repairActor.output()).some((event) => event.type === "answer" && event.text === peerAnswer));
      assert.equal((await tasks()).length, before.length + 1);
      assert.equal((await tasks()).filter((task) => task.title === secondInput).length, 1);
      assert.equal((await mainHistory()).messages.filter((message) => message.role === "user" && message.text === input.input).length, 1);
      for (const path of [firstPath, secondPath]) assert.equal(await stat(path + ".finished").then(() => true, () => false), false,
        "Read and worker-control requests must complete while both real host effects remain held");
      await writeFile(secondPath + ".release", "Finish the independent task first.");
      await until(async () => events(parallel.output()).some((event) => event.type === "answer" && event.text === secondAnswer));
      assert.equal(await stat(firstPath + ".finished").then(() => true, () => false), false);
      await writeFile(firstPath + ".release", "Finish the original worker.");
      await until(async () => events(actor.output()).some((event) => event.type === "answer" && event.text === firstAnswer));
      for (const path of [firstPath, secondPath]) assert.equal(await readFile(path + ".finished", "utf8"), "once\n");
      assert.deepEqual((await tasks()).find((task) => task.id === old.id)?.worker, originalAfterFeedback.worker);
      parallel.child.stdin.end("/exit\n"); assert.equal(await parallel.exited, 0, parallel.errors());
    });
    for (const [name, key, host] of [["exit", "/exit\r", 1], ["control-c", "\u0003", 0]] satisfies [string, string, number][]) {
      const path = join(directory, "detach-" + name), input = "fixture-detach-" + name, answer = "Detached " + name + " completed.";
      const workerInput = "fixture-worker-detach-" + name, workerAnswer = "Worker continued after " + name + ".";
      await script(input, [held(path), { tool: "delegate_task", args: { task_id: old.id, input: workerInput } }, { text: answer }]);
      await script(workerInput, [{ text: workerAnswer }]);
      const terminal = start(host, [], undefined, {}, false, true);
      await until(async () => terminal.output().includes("Ask Beep Boop to do anything"), "The native main TUI did not start");
      terminal.child.stdin.write(input + "\r");
      await until(async () => stat(path + ".started").then(() => true, () => false), "The real coordinator action did not start");
      terminal.child.stdin.write(key);
      await until(async () => terminal.child.exitCode !== null || terminal.child.signalCode !== null,
        "Detaching the main TUI must not wait for the held server action");
      assert.equal(await terminal.exited, 0, terminal.errors());
      assert.equal(await stat(path + ".finished").then(() => true, () => false), false);
      const reopened = start(host, [], undefined, {}, false, true);
      await until(async () => reopened.output().includes("Working"), "Reopening must attach to the active main execution");
      const liveFrames: RuntimeEventKind[] = [];
      const live = exchange({ type: "attach_main" }, (frame) => { liveFrames.push(frame); }); void live.catch(() => {});
      await until(async () => liveFrames.some((frame) => frame.type === "main_ready"));
      const steering = "fixture-steer-detached-" + name;
      await script(steering, [{ tool: "delegate_task", args: { task_id: old.id, input: workerInput } }, { text: answer }]);
      reopened.child.stdin.write(steering + "\r");
      await until(async () => liveFrames.some((frame) => frame.type === "input_accepted"), "The reopened main view must steer the existing execution");
      // The native terminal emits changed cells. "sending" can donate the
      // unchanged leading s to "steering", so assert the newly drawn status.
      await until(async () => reopened.output().includes("waiting"), "Accepted steering must remain visibly pending at the held tool boundary");
      assert.equal(await stat(path + ".finished").then(() => true, () => false), false,
        "Steering must not cancel or restart the held action");
      const queuedInput = "fixture-queued-detached-" + name, queuedAnswer = "A separate queued " + name + " turn completed.";
      await script(queuedInput, [{ text: queuedAnswer }]); reopened.child.stdin.write(queuedInput + "\t");
      await until(async () => liveFrames.filter((frame) => frame.type === "input_accepted").length === 2,
        "The reopened main view must preserve Tab as a later turn");
      await writeFile(path + ".release", "continue the server-owned action");
      await until(async () => (await mainHistory()).messages.some((message) => message.text === answer),
        "The admitted main action must finish after its terminal exits");
      await until(async () => events(actor.output()).some((event) => event.type === "answer" && event.text === workerAnswer),
        "Detached main work must still be able to continue its existing worker");
      assert.equal(await readFile(path + ".finished", "utf8"), "once\n");
      assert.equal((await mainHistory()).messages.filter((message) => message.text === answer).length, 1);
      await until(async () => (await mainHistory()).messages.some((message) => message.text === queuedAnswer));
      const separate = (await mainHistory()).messages;
      assert.equal(separate.filter((message) => message.text === queuedAnswer).length, 1);
      assert.notEqual(separate.find((message) => message.text === answer)?.entry_id, separate.find((message) => message.text === queuedAnswer)?.entry_id);
      const completed = await live;
      assert.deepEqual(completed.flatMap((frame) => frame.type === "answer" ? [frame.text] : []), [answer, queuedAnswer]);
      const followup = "fixture-after-detach-" + name, followupAnswer = "A new message follows the detached " + name + " work.";
      const multiline = followup + "\nKeep both lines in one request.";
      await script(followup, [{ text: followupAnswer }]);
      reopened.child.stdin.write(followup + "\u001b[13;2uKeep both lines in one request.\r");
      await until(async () => (await mainHistory()).messages.some((message) => message.text === followupAnswer));
      const recalled = (await mainHistory()).messages;
      assert.equal(recalled.filter((message) => message.role === "user" && message.text === multiline).length, 1,
        "Shift+Enter must create one native multiline message");
      reopened.child.stdin.write("/exit\r"); assert.equal(await reopened.exited, 0, reopened.errors());
      const resumedTask: TaskRecord | undefined = (await tasks()).find((task) => task.id === old.id); assert.ok(resumedTask?.worker.state === "bound");
      assert.deepEqual(resumedTask.worker.binding, original.binding);
      assert.equal(new Set(sessions(join(homes[1]!, "rex.json")).map((window) => window.session_id)).size, 2);
    }
    const stopPath = join(directory, "explicit-stop"), stopAnswer = "An explicitly stopped action must not finish.";
    await script("fixture-explicit-stop", [held(stopPath), { text: stopAnswer }]);
    const detachedStop = start(0, [], undefined, {}, false, true);
    await until(async () => detachedStop.output().includes("Ask Beep Boop to do anything"));
    detachedStop.child.stdin.write("fixture-explicit-stop\r");
    await until(async () => stat(stopPath + ".started").then(() => true, () => false));
    detachedStop.child.stdin.write("/exit\r"); assert.equal(await detachedStop.exited, 0, detachedStop.errors());
    const stopped = start(0, [], undefined, {}, false, true);
    await until(async () => stopped.output().includes("Working"));
    stopped.child.stdin.write("\u001b");
    await until(async () => stopped.output().includes("Interrupted"), "Esc must stop the active turn");
    await script("fixture-after-explicit-stop", [{ text: "The main chat accepts a new message after explicit stop." }]);
    stopped.child.stdin.write("fixture-after-explicit-stop\r");
    await until(async () => (await mainHistory()).messages.some((message) => message.text === "The main chat accepts a new message after explicit stop."));
    await writeFile(stopPath + ".release", "a stopped action must remain stopped");
    assert.equal(await stat(stopPath + ".finished").then(() => true, () => false), false);
    assert.equal((await mainHistory()).messages.some((message) => message.text === stopAnswer), false);
    stopped.child.stdin.write("/exit\r"); assert.equal(await stopped.exited, 0, stopped.errors());

    const gapPath = join(directory, "finish-before-attach"), gapAnswer = "A completed turn remains visible across the attach boundary.";
    await script("fixture-finish-before-attach", [held(gapPath), { text: gapAnswer }]);
    const gapOwner = start(0, ["chat", "fixture-finish-before-attach"]);
    await until(async () => stat(gapPath + ".started").then(() => true, () => false));
    const earlierSnapshot = await mainHistory(); assert.equal(earlierSnapshot.messages.some((message) => message.text === gapAnswer), false);
    await writeFile(gapPath + ".release", "finish before the new view attaches");
    assert.equal(await gapOwner.exited, 0, gapOwner.errors());
    const requestsBeforeAttach = await readFile(queue + ".requests", "utf8");
    const attachedAfterFinish = (await exchange({ type: "attach_main" })).find((event) => event.type === "history");
    assert.ok(attachedAfterFinish?.type === "history", "An idle main attach must refresh a snapshot taken before the previous execution finished");
    assert.equal(attachedAfterFinish.conversation_id, chiefConversationId);
    assert.equal(attachedAfterFinish.messages.filter((message) => message.text === gapAnswer).length, 1);
    assert.equal(await readFile(queue + ".requests", "utf8"), requestsBeforeAttach, "Attaching an idle main view must not invoke a model");
    assert.equal(await readFile(gapPath + ".finished", "utf8"), "once\n");

    const localStatus = start(0, ["chat", "/status"], undefined, {}, false, true);
    await until(async () => localStatus.child.exitCode !== null || localStatus.child.signalCode !== null,
      "An initial slash command must complete locally before opening a chat turn");
    assert.equal(await localStatus.exited, 0, localStatus.errors()); assert.ok(localStatus.output().includes("Coordinator:"));
    assert.equal((await mainHistory()).messages.some((message) => message.role === "user" && message.text === "/status"), false);
    assert.equal(await readFile(queue + ".requests", "utf8"), requestsBeforeAttach);

    const canonical = start(0, [], undefined, {}, false, true, process.env.AGENT_TEST_NOTICE_BINARY ?? binary);
    await until(async () => canonical.output().includes("Sapphire main detail retained."));
    const noticeOffset = canonical.output().length;
    const noticeInput = "fixture-canonical-worker-notice", noticeBody = "One durable worker result appears in the main chat.";
    const internal = "Worker state and tool receipts are recorded.";
    await script(noticeInput, [{ text: internal }]); actor.child.stdin.write(noticeInput + "\n");
    await until(async () => actor.output().includes(internal));
    assert.equal((await mainHistory()).messages.some((message) => message.text === internal), false);
    await script("fixture-curated-worker-notice", [{ tool: "notify", args: { keys: [], text: noticeBody } }, { text: "" }]);
    await cli(0, ["chat", "fixture-curated-worker-notice"]);
    await until(async () => canonical.output().slice(noticeOffset).includes(noticeBody));
    const savedNotices = (await mainHistory()).messages.filter((message) => message.role === "notice" && message.text === noticeBody);
    assert.equal(savedNotices.length, 1, "The worker result must have one canonical saved root entry");
    canonical.child.stdin.write("/exit\r"); assert.equal(await canonical.exited, 0, canonical.errors());
    const liveNotice = canonical.output().slice(noticeOffset);
    assert.equal(liveNotice.includes(old.title + ": " + noticeBody), false, "Observer-backed chat must not also render the legacy anonymous notification");
    assert.equal(liveNotice.split(noticeBody).length - 1, 1, "Live rendering must use the one canonical notice entry");
    const noticeReplay = start(0, [], undefined, {}, false, true, process.env.AGENT_TEST_NOTICE_BINARY ?? binary);
    await until(async () => noticeReplay.output().includes(noticeBody));
    noticeReplay.child.stdin.write("/exit\r"); assert.equal(await noticeReplay.exited, 0, noticeReplay.errors());
    assert.equal(noticeReplay.output().split(noticeBody).length - 1, 1, "Reopening must project the same saved notice once");
    const persistedNotice = (await mainHistory()).messages.find((message) => message.role === "notice" && message.text === noticeBody);
    assert.equal(persistedNotice?.entry_id, savedNotices[0]?.entry_id, "Live and reopened views must share the original native identity");

    const plainNotice = "A useful plaintext notice appears exactly once.", plainAnswer = "The plaintext chief handled the request.";
    await script("fixture-plain-notice", [{ tool: "notify", args: { keys: [], text: plainNotice } }, { text: plainAnswer }]);
    const plain = start(0, ["--no-tui"], undefined, {}, false, true, process.env.AGENT_TEST_PLAIN_BINARY ?? binary);
    await until(async () => plain.output().includes("Beep Boop> "));
    plain.child.stdin.write("fixture-plain-notice\n");
    await until(async () => plain.output().includes(plainAnswer));
    plain.child.stdin.write("/exit\n"); assert.equal(await plain.exited, 0, plain.errors());
    assert.equal(plain.output().split(plainNotice).length - 1, 1,
      "The watched plain chief must not also render its direct duplicate notification");
    const opened = start(0, ["--no-tui", "history", "open", old.conversation_id], undefined, {}, false, true);
    assert.equal(await opened.exited, 0, opened.errors());
    assert.equal(opened.output().split("Opened " + old.title).length - 1, 1,
      "A one-off history command must retain its direct acknowledgment");

    const automatic = start(1, [], undefined, {}, false, true, process.env.AGENT_TEST_HISTORY_BINARY ?? binary);
    await until(async () => automatic.output().includes("Sapphire main detail retained."),
      "The native terminal must expose history older than its first20-entry page without /history");
    automatic.child.stdin.write("/exit\r"); assert.equal(await automatic.exited, 0, automatic.errors());
    const historyGate = join(directory, "history-replay");
    const replayed = start(1, [], undefined, { AGENT_TEST_HISTORY_GATE: historyGate }, false, true);
    await until(async () => stat(historyGate + ".entered").then(() => true, () => false),
      "A selected conversation must automatically request older native pages");
    const duringReplay = "fixture-steer-during-history", replayAnswer = "Input remains responsive while older pages wait.";
    await script(duringReplay, [{ text: replayAnswer }]);
    replayed.child.stdin.write(duringReplay + "\r");
    await until(async () => (await mainHistory()).messages.some((message) => message.text === replayAnswer),
      "Historical replay must not block independent input admission or inference");
    await writeFile(historyGate + ".release", "Release only this view's older page.");
    await until(async () => replayed.output().includes("Sapphire main detail retained."),
      "The native terminal must expose history older than its first20-entry page without /history");
    const requestsBeforeResume = await readFile(queue + ".requests", "utf8");
    const sessionsBeforeResume = sessions(join(homes[1]!, "rex.json"));
    replayed.child.stdin.write("/resume\r");
    await until(async () => replayed.output().includes("Resume conversation"));
    replayed.child.stdin.write("\u001b[27u");
    const resumeOffset = replayed.output().length;
    replayed.child.stdin.write("/resume " + old.id + "\r");
    await until(async () => replayed.output().slice(resumeOffset).includes("Sapphire laptop measurement retained."),
      "An exact task ID must switch this terminal to its existing saved worker conversation");
    assert.equal(await readFile(queue + ".requests", "utf8"), requestsBeforeResume,
      "Browsing and attaching must not submit model input");
    assert.deepEqual(sessions(join(homes[1]!, "rex.json")), sessionsBeforeResume,
      "An in-place view must not allocate or focus another Rex folder or terminal");
    const resumedInput = "fixture-resumed-worker", resumedAnswer = "The same Rex-owned worker answers the selected view.";
    await script(resumedInput, [{ text: resumedAnswer }]);
    replayed.child.stdin.write(resumedInput + "\r");
    await until(async () => events(actor.output()).some((event) => event.type === "answer" && event.text === resumedAnswer),
      "The selected view input must reach its already-running worker", () => replayed.output().slice(-8000) + "\nActor:\n" + actor.output().slice(-3000));
    await until(async () => replayed.output().includes(resumedAnswer));
    assert.deepEqual((await tasks()).find((task) => task.id === old.id)?.worker, originalAfterFeedback.worker);
    replayed.child.stdin.write("/exit\r"); assert.equal(await replayed.exited, 0, replayed.errors());
    assert.equal(actor.child.exitCode, null, "Closing a view must not stop its independently owned worker");

    for (const navigation of ["resume", "interrupt", "failed-interrupt"]) {
      const attachGate = join(directory, "attach-" + navigation);
      const interruptGate = join(directory, "before-restored-input-" + navigation), interrupting = navigation !== "resume";
      const waiting = start(1, [], undefined, { AGENT_TEST_ATTACH_GATE: attachGate,
        ...(interrupting ? { AGENT_TEST_INTERRUPT_GATE: interruptGate } : {}) }, false, true,
        process.env.AGENT_TEST_ADMISSION_BINARY ?? binary);
      await until(async () => stat(attachGate + ".entered").then(() => true, () => false));
      const unsent = "fixture-not-admitted-" + navigation;
      const before = await readFile(queue + ".requests", "utf8");
      waiting.child.stdin.write(unsent + "\r");
      await until(async () => waiting.output().includes(unsent));
      let restoredAt = waiting.output().length;
      if (navigation === "resume") {
        waiting.child.stdin.write("/resume " + old.id + "\r");
        await until(async () => waiting.output().includes("Sapphire laptop measurement retained."));
        restoredAt = waiting.output().length;
        waiting.child.stdin.write("/resume " + chiefConversationId + "\r");
      } else waiting.child.stdin.write("\u001b[27u");
      await writeFile(attachGate + ".release", "Complete observation after canceling the proven-unsent input.");
      await until(async () => waiting.output().includes("Sapphire main detail retained."));
      await until(async () => waiting.output().slice(restoredAt).includes(unsent),
        "A proven-unsent message must return to its own conversation's visible draft");
      const admitted = "fixture-after-canceled-" + navigation, answer = "The restored draft was sent deliberately after " + navigation + ".";
      const action = join(directory, "restored-input-" + navigation);
      await script(admitted, [...(interrupting ? [held(action)] : []), { text: answer }]);
      // Replace the restored draft explicitly. It must not have been silently
      // redirected to the selected task or sent when the old view became ready.
      waiting.child.stdin.write("\u0001\u000b" + admitted + "\r");
      if (interrupting) {
        await until(async () => stat(interruptGate + ".entered").then(() => true, () => false));
        await until(async () => waiting.output().includes(admitted));
        const unrelated = "fixture-worker-during-" + navigation, unrelatedAnswer = "The other conversation remains independent of " + navigation + ".";
        await script(unrelated, [{ text: unrelatedAnswer }]); actor.child.stdin.write(unrelated + "\n");
        await until(async () => events(actor.output()).some((event) => event.type === "answer" && event.text === unrelatedAnswer));
        // Keep the previous interrupt outstanding while the next input is
        // already visible. Its independently owned admission must wait too.
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(await stat(action + ".started").then(() => true, () => false), false,
          "A new input overtook its conversation's pending interrupt receipt");
        if (navigation === "failed-interrupt") await writeFile(interruptGate + ".fail", "Fail before forwarding the native interrupt.");
        await writeFile(interruptGate + ".release", "Finish the earlier interrupt before admitting the next input.");
        if (navigation === "failed-interrupt") {
          await until(async () => waiting.output().includes("interruption could not be confirmed"));
          assert.equal((await mainHistory()).messages.some((message) => message.text === admitted), false);
          waiting.child.stdin.write("\u0001\u000b/exit\r"); assert.equal(await waiting.exited, 0, waiting.errors());
          continue;
        }
        await until(async () => stat(action + ".started").then(() => true, () => false));
        await writeFile(action + ".release", "Complete the new input after the earlier interrupt.");
      }
      await until(async () => {
        assert.equal(waiting.child.exitCode, null, "The restored view exited: " + waiting.output().slice(-8000));
        return (await mainHistory()).messages.some((message) => message.text === answer);
      }, "The restored draft must be delivered after " + navigation, () => waiting.output().slice(-12000));
      const newRequests = (await readFile(queue + ".requests", "utf8")).slice(before.length);
      assert.equal(newRequests.includes(unsent), false, "A canceled pre-Ready input must never be admitted later");
      assert.equal((await mainHistory()).messages.some((message) => message.text === unsent), false);
      waiting.child.stdin.write("/exit\r"); assert.equal(await waiting.exited, 0, waiting.errors());
    }

    const earlyGate = join(directory, "attach-before-exit"), earlyAction = join(directory, "early-exit-action");
    const earlyInput = "fixture-exit-before-ready", earlyAnswer = "A quickly detached input still finishes once.";
    await script(earlyInput, [held(earlyAction), { text: earlyAnswer }]);
    const earlyExit = start(1, [], undefined, { AGENT_TEST_ATTACH_GATE: earlyGate }, false, true);
    await until(async () => stat(earlyGate + ".entered").then(() => true, () => false));
    earlyExit.child.stdin.write(earlyInput + "\r/exit\r");
    await until(async () => earlyExit.output().includes(earlyInput));
    assert.equal(earlyExit.child.exitCode, null, "Exit must hand off an unsent input before closing its observer");
    await writeFile(earlyGate + ".release", "Allow observation and independent input admission.");
    await until(async () => earlyExit.child.exitCode !== null || earlyExit.child.signalCode !== null,
      "Exit must wait only for admission, not the held model action");
    assert.equal(await earlyExit.exited, 0, earlyExit.errors());
    await until(async () => stat(earlyAction + ".started").then(() => true, () => false));
    assert.equal(await stat(earlyAction + ".finished").then(() => true, () => false), false);
    await writeFile(earlyAction + ".release", "Finish independently after the terminal exited.");
    await until(async () => (await mainHistory()).messages.some((message) => message.text === earlyAnswer));
    assert.equal(await readFile(earlyAction + ".finished", "utf8"), "once\n");

    const chiefModel = (await exchange({ type: "conversation_settings", task_id: null, agent_id: null, change: null, catalog: false }))
      .find((event) => event.type === "conversation_settings");
    assert.ok(chiefModel?.type === "conversation_settings");
    const selectedModel = start(1, ["chat", "/resume " + old.id, "--reasoning", "medium"], undefined, {}, false, true);
    await until(async () => selectedModel.output().includes("Sapphire laptop measurement retained."));
    selectedModel.child.stdin.write("/exit\r"); assert.equal(await selectedModel.exited, 0, selectedModel.errors());
    const afterModel = (await exchange({ type: "conversation_settings", task_id: null, agent_id: null, change: null, catalog: false }))
      .find((event) => event.type === "conversation_settings");
    assert.ok(afterModel?.type === "conversation_settings");
    assert.deepEqual(afterModel.settings.model, chiefModel.settings.model,
      "Model overrides on an initial /resume must configure the chosen chat, never the chief");
    const resumedModel = (await exchange({ type: "conversation_settings", task_id: old.id, agent_id: null, change: null, catalog: false }))
      .find((event) => event.type === "conversation_settings");
    assert.ok(resumedModel?.type === "conversation_settings"); assert.equal(resumedModel.settings.model.reasoning, "medium");

    actor.child.stdin.write("/reasoning medium\n");
    await until(async () => events(actor.output()).some((event) => event.type === "conversation_settings" && event.settings.model.reasoning === "medium"));
    repairActor.child.stdin.end("/exit\n"); assert.equal(await repairActor.exited, 0, repairActor.errors());
    actor.child.stdin.end("/exit\n"); assert.equal(await actor.exited, 0, actor.errors());
    actor = run();
    await until(async () => events(actor.output()).some((event) => event.type === "worker_idle"));
    const finalSettings = events(actor.output()).find((event) => event.type === "conversation_settings");
    assert.ok(finalSettings?.type === "conversation_settings"); assert.equal(finalSettings.settings.model.reasoning, "medium");
    assert.equal(finalSettings.settings.conversation_id, old.conversation_id);
    const finalTask: TaskRecord | undefined = (await tasks()).find((task) => task.id === old.id); assert.ok(finalTask?.worker.state === "bound");
    assert.deepEqual(finalTask.worker.binding, original.binding);
    actor.child.stdin.end("/exit\n"); assert.equal(await actor.exited, 0, actor.errors());
    worker.child.kill("SIGINT"); await worker.exited; server.child.kill("SIGTERM"); assert.equal(await server.exited, 0, server.errors());
  } finally {
    for (const owned of children.slice().reverse()) if (owned.child.pid !== undefined && owned.child.exitCode === null && owned.child.signalCode === null) {
      try { process.kill(-owned.child.pid, "SIGTERM"); } catch { /* This owned group already exited. */ }
    }
    await Promise.race([Promise.allSettled(children.map((owned) => owned.exited)), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    for (const owned of children) if (owned.child.pid !== undefined && owned.child.exitCode === null && owned.child.signalCode === null) {
      try { process.kill(-owned.child.pid, "SIGKILL"); } catch { /* This owned group already exited. */ }
    }
    await Promise.allSettled(children.map((process) => process.exited)); await rm(directory, { recursive: true, force: true });
  }
});
