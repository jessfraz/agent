import { DEFAULT_MODEL } from "../src/models.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validEvent } from "../src/protocol.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";

test("real Pi bridge gives signed-out chat the login command before starting Pi and rejects invalid commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-"));
  await chmod(directory, 0o700);
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  try {
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end([
      JSON.stringify({ version: 1, id: 1, command: { type: "status" } }),
      JSON.stringify({ version: 1, id: 2, command: { type: "invented" } }),
      JSON.stringify({ version: 1, id: 3, command: { type: "chat", input: "Hello", instructions: "",
        model: DEFAULT_MODEL, origin_host_id: null, cwd: "/workspace/example", hosts: [] } }),
      "invalid json", "",
    ].join("\n"));
    const code = await exited;
    assert.equal(code, 0, errors);
    const events: RuntimeEvent[] = output.trim().split("\n").map((line) => {
      const event: unknown = JSON.parse(line);
      assert.ok(validEvent(event));
      return event;
    });
    assert.deepEqual(events.filter((event) => event.id === 1), [
      { version: 1, id: 1, event: { type: "auth_status", status: { state: "signed_out" } } },
      { version: 1, id: 1, event: { type: "done" } },
    ]);
    assert.deepEqual(events.filter((event) => event.id === 3), [
      { version: 1, id: 3, event: { type: "failure", code: "authentication_required",
        message: "Not signed in to ChatGPT. Run agent login." } },
      { version: 1, id: 3, event: { type: "done" } },
    ]);
    assert.equal(events.filter((event) => event.event.type === "failure").length, 3);
    assert.equal(events.filter((event) => event.event.type === "done").length, 4);
    assert.deepEqual(await readdir(directory), ["auth.json"], "Signed-out chat must not open Pi conversation storage");
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real bridge reads canonical settings and node history before a default-model chat", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-")); await chmod(directory, 0o700);
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout }); let sequence = 0;
  const request = (command: RuntimeCommand): Promise<RuntimeEvent[]> => {
    const id = ++sequence; const events: RuntimeEvent[] = [];
    return new Promise((resolve, reject) => {
      const collect = (line: string) => {
        const frame: unknown = JSON.parse(line);
        if (!validEvent(frame)) { reject(new Error("Invalid runtime frame")); return; }
        if (frame.id !== id) return;
        events.push(frame);
        if (frame.event.type === "done") { lines.off("line", collect); resolve(events); }
      };
      lines.on("line", collect);
      child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
    });
  };
  const node = { host_id: "11111111-1111-4111-8111-111111111111", name: "fixture", rex_server: null,
    home_directory: "/home/fixture", agent_program: "/example/agent", coordinator: null,
    launch: { state_dir: null, runtime: null, config: null, instructions: null, model: null } };
  try {
    assert.deepEqual((await request({ type: "configure_coordinator", bootstrap: { node,
      settings: { model: DEFAULT_MODEL, instructions: "Brief updates.", context_repositories: [], sources: [] } } })).map((frame) => frame.event.type), ["configured", "done"]);
    await request({ type: "register_node", node }); await request({ type: "set_connected_nodes", host_ids: [node.host_id] });
    const snapshot = (await request({ type: "environment" })).find((frame) => frame.event.type === "environment")?.event;
    assert.ok(snapshot?.type === "environment"); assert.equal(snapshot.nodes.length, 1);
    assert.deepEqual(snapshot.online_host_ids, [node.host_id]); assert.deepEqual(snapshot.settings.model, DEFAULT_MODEL);
    const response = await request({ type: "chat", input: "Hello", instructions: "Project instructions.", model: null,
      origin_host_id: node.host_id, cwd: "/home/fixture/project", hosts: [] });
    assert.deepEqual(response.map((frame) => frame.event), [
      { type: "failure", code: "authentication_required", message: "Not signed in to ChatGPT. Run agent login." }, { type: "done" },
    ]);
  } finally { lines.close(); child.stdin.end(); child.kill(); await closed; await rm(directory, { recursive: true, force: true }); }
});

test("real bridge ignores a delayed interrupt after Done and still interrupts active chat", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-late-interrupt-")); await chmod(directory, 0o700);
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const lines = createInterface({ input: child.stdout });
  const frames: RuntimeEvent[] = [];
  const completed = new Map<number, () => void>();
  let errors = ""; child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  lines.on("line", (line) => {
    const event: unknown = JSON.parse(line); assert.ok(validEvent(event)); frames.push(event);
    if (event.event.type === "done") completed.get(event.id)?.();
  });
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const done = (id: number) => new Promise<void>((resolve) => { completed.set(id, resolve); });
  const chat: RuntimeCommand = { type: "chat", input: "Synthetic fixture", instructions: "", model: DEFAULT_MODEL,
    origin_host_id: null, cwd: "/tmp", hosts: [] };
  try {
    const first = done(1); send(1, chat); await first;
    // Rust can still have this request pending while Done waits unread in its pipe.
    send(1, { type: "interrupt" });
    const barrier = done(2); send(2, { type: "status" }); await barrier;
    const active = done(3); send(3, chat); send(3, { type: "interrupt" }); await active;
    child.stdin.end(); assert.equal(await closed, 0, errors);
    assert.deepEqual(frames.filter((frame) => frame.id === 1).map((frame) => frame.event.type), ["failure", "done"],
      "A stale control must not emit another frame after the request's Done");
    assert.deepEqual(frames.filter((frame) => frame.id === 3).map((frame) => frame.event.type), ["interrupted", "done"]);
  } finally { lines.close(); child.kill(); await closed; await rm(directory, { recursive: true, force: true }); }
});
