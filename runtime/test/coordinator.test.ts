import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validEvent } from "../src/protocol.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import { sessions } from "./fixtures/coordinator-native.js";
import type { ModelQueue, ModelStep } from "./fixtures/coordinator-runtime.js";

test("real CLI, coordinator and worker retain main history across an offline laptop and route restored work", { timeout: 60_000 }, async () => {
  const directory = await realpath(await mkdtemp("/tmp/agent-e2e-"));
  const binary = process.env.AGENT_TEST_BINARY ?? fileURLToPath(new URL("../../../target/debug/agent", import.meta.url));
  const runtime = fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url));
  const coordinator = "11111111-1111-4111-8111-111111111111", laptop = "22222222-2222-4222-8222-222222222222";
  const bin = join(directory, "bin"), queue = join(directory, "responses.json");
  const homes = [join(directory, "desktop"), join(directory, "laptop")];
  const socket = join(homes[0]!, "state", "agent.sock");
  const children: { child: ChildProcessWithoutNullStreams; exited: Promise<number | null>; output: () => string; errors: () => string }[] = [];
  const events = (text: string): RuntimeEventKind[] => text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => {
    const event: unknown = JSON.parse(line), frame = { version: 1, id: 1, event };
    assert.ok(validEvent(frame), "The real CLI must return typed protocol events"); return frame.event;
  });
  function start(host: number, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}, nativeArguments = false) {
    const home = homes[host]; assert.ok(home);
    const arguments_ = nativeArguments ? args : ["--state-dir", join(home, "state"), "--config", join(home, "agent.toml"),
      "--runtime", runtime, "--instructions", join(home, "AGENTS.md"), ...args];
    const child = spawn(binary, ["--json", "--no-tui", ...arguments_], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: bin + delimiter + process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local"),
      TMPDIR: directory, AGENT_SQLITE_VEC: process.env.AGENT_SQLITE_VEC, OPENAI_API_KEY: "sk-synthetic-fixture",
      AGENT_TEST_NODE_ID: host === 0 ? coordinator : laptop, AGENT_TEST_REX_STATE: join(home, "rex.json"),
      AGENT_TEST_MODEL_QUEUE: queue, AGENT_TEST_COORDINATOR_SOCKET: socket, ...extra,
    } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const owned = { child, exited, output: () => stdout, errors: () => stderr }; children.push(owned);
    if (input !== undefined) child.stdin.end(input);
    return owned;
  }
  async function cli(host: number, args: string[], input = "") {
    const process = start(host, args, input); assert.equal(await process.exited, 0, process.errors()); return events(process.output());
  }
  async function until(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!await check()) { assert.ok(Date.now() < deadline, children.map((process) => process.errors()).join("\n")); await new Promise((resolve) => setTimeout(resolve, 20)); }
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
    const first = (await cli(1, ["chat", "fixture-initial-main: remember the sapphire connector."])).find((event) => event.type === "answer"); assert.ok(first?.type === "answer");
    const old = (await tasks()).find((task) => task.title === "fixture-initial-worker"); assert.ok(old?.worker.state === "bound");
    const original = old.worker, launch = sessions(join(homes[1]!, "rex.json")).find((session) => session.session_id === original.binding.session_id); assert.ok(launch);
    const run = () => start(1, launch.command.slice(1), undefined, { REX_SESSION: launch.session_id, REX_BLOCK: launch.block_id }, true);
    await script("fixture-initial-worker", [{ text: "Sapphire laptop measurement retained." }]);
    let actor = run(); await until(async () => events(actor.output()).some((event) => event.type === "worker_idle"));
    actor.child.stdin.end("/exit\n"); assert.equal(await actor.exited, 0, actor.errors());
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
    for (const [index, host, count] of [[0, coordinator, 3], [1, laptop, 1]] satisfies [number, string, number][]) {
      const effects: unknown[] = (await readFile(join(homes[index]!, "effects"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(effects, Array.from({ length: count }, () => ({ host, cwd: homes[index] })));
    }
    const requests: unknown[] = (await readFile(queue + ".requests", "utf8")).trim().split("\n").map((line) => JSON.parse(line));
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
