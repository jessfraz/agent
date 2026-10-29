import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { HistoryStore } from "../src/history.js";
import { DEFAULT_MODEL } from "../src/models.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validEvent } from "../src/protocol.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";

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
      JSON.stringify({ version: 1, id: 3, command: { type: "chat", input: "Hello", input_id: "initial-input", instructions: "",
        model: DEFAULT_MODEL, origin_host_id: null, cwd: "/workspace/example", hosts: [] } }),
      JSON.stringify({ version: 1, id: 4, command: { type: "usage", provider: "openai" } }),
      JSON.stringify({ version: 1, id: 5, command: { type: "usage", provider: "anthropic" } }),
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
      { version: 1, id: 3, event: { type: "input_rejected", input_id: "initial-input",
        message: "Input was not submitted; its draft is restored." } },
      { version: 1, id: 3, event: { type: "failure", code: "authentication_required",
        message: "Not signed in to ChatGPT. Run agent login." } },
      { version: 1, id: 3, event: { type: "done" } },
    ]);
    assert.equal(events.filter((event) => event.event.type === "failure").length, 3);
    assert.deepEqual(events.filter((event) => event.id === 4), [
      { version: 1, id: 4, event: { type: "usage", usage: { state: "unavailable", reason: "not_signed_in" } } },
      { version: 1, id: 4, event: { type: "done" } },
    ]);
    assert.deepEqual(events.filter((event) => event.id === 5), [
      { version: 1, id: 5, event: { type: "usage", usage: { state: "unavailable", reason: "unsupported_provider" } } },
      { version: 1, id: 5, event: { type: "done" } },
    ]);
    assert.equal(events.some((event) => event.event.type === "host_call"), false, "Unknown or unsupported accounts must not query a different account or trigger login");
    assert.equal(events.filter((event) => event.event.type === "done").length, 6);
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
    const snapshot = (await request({ type: "environment", telemetry: false })).find((frame) => frame.event.type === "environment")?.event;
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

test("real bridge confines malformed host replies to their matching operation", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-invalid-reply-")); await chmod(directory, 0o700);
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const lines = createInterface({ input: child.stdout }); const frames: RuntimeEvent[] = [];
  const waiting = new Map<string, (event: RuntimeEventKind) => void>();
  let errors = ""; child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  lines.on("line", (line) => {
    const event: unknown = JSON.parse(line); assert.ok(validEvent(event)); frames.push(event);
    waiting.get(`${event.id}:${event.event.type}`)?.(event.event);
  });
  const event = (id: number, type: RuntimeEventKind["type"]): Promise<RuntimeEventKind> => {
    const saved = frames.find((frame) => frame.id === id && frame.event.type === type);
    return saved === undefined ? new Promise((resolve) => { waiting.set(`${id}:${type}`, resolve); }) : Promise.resolve(saved.event);
  };
  const write = (frame: unknown) => child.stdin.write(JSON.stringify(frame) + "\n");
  const send = (id: number, command: RuntimeCommand) => write({ version: 1, id, command });
  const space: EmbeddingSpace = { id: "synthetic", model_revision: "fixture", model_digest: "fixture", dimensions: 3,
    pooling: "last", normalization: "l2", instruction_version: 1 };
  const invalid = { type: "embeddings", batch: { space, vectors: [["private payload must not enter diagnostics"]] } };
  const malformed = (id: number, call_id: string) => write({ version: 1, id, command: { type: "host_reply", call_id, result: invalid } });
  try {
    send(1, { type: "search_history", query: "synthetic first", limit: 8, mode: "semantic" });
    send(2, { type: "search_history", query: "synthetic second", limit: 8, mode: "semantic" });
    const [first, second] = await Promise.all([event(1, "host_call"), event(2, "host_call")]);
    assert.ok(first.type === "host_call" && second.type === "host_call");
    assert.equal(first.command.type, "embed"); assert.equal(second.command.type, "embed");
    malformed(2, first.call_id); malformed(1, "unknown-call");
    send(3, { type: "status" }); await event(3, "done");
    assert.equal(frames.some((frame) => frame.id === 0), false, "A malformed host reply must not create an unowned request-zero frame");
    assert.equal(frames.some((frame) => frame.id <= 2 && frame.event.type === "done"), false,
      "Neither another request ID nor an unknown call ID may settle a pending operation");
    malformed(1, first.call_id); await event(1, "done");
    const failed = await event(1, "saved_matches"); assert.ok(failed.type === "saved_matches");
    assert.ok(failed.gaps.some((gap) => /invalid host reply/iu.test(gap)));
    assert.ok(failed.gaps.some((gap) => /schema/iu.test(gap)), "Failure should retain bounded validation metadata");
    assert.equal(frames.some((frame) => frame.id === 2 && frame.event.type === "done"), false);
    send(2, { type: "host_reply", call_id: second.call_id, result: { type: "embeddings", batch: { space, vectors: [[1, 0, 0]] } } });
    await event(2, "done"); const healthy = await event(2, "saved_matches"); assert.ok(healthy.type === "saved_matches");
    assert.deepEqual(healthy.gaps, []);
    assert.equal(JSON.stringify(frames).includes("private payload must not enter diagnostics"), false);
    child.stdin.end(); assert.equal(await closed, 0, errors);
    assert.equal(errors.includes("private payload must not enter diagnostics"), false);
  } finally { lines.close(); child.kill(); await closed; await rm(directory, { recursive: true, force: true }); }
});

test("real bridge preserves literal Unicode separators through LF-framed requests and responses", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-unicode-frames-")); await chmod(directory, 0o700);
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const frames: RuntimeEvent[] = []; let buffered = Buffer.alloc(0); let errors = "";
  const completed = new Map<number, () => void>();
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  // Read the actual wire delimiter, independently of both readline and the production decoder.
  child.stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (let end = buffered.indexOf(0x0a); end >= 0; end = buffered.indexOf(0x0a)) {
      const value: unknown = JSON.parse(buffered.subarray(0, end).toString("utf8")); buffered = buffered.subarray(end + 1);
      assert.ok(validEvent(value)); frames.push(value);
      if (value.event.type === "done") {
        if (value.id === 0) for (const resolve of completed.values()) resolve();
        else completed.get(value.id)?.();
      }
    }
  });
  const done = (id: number) => new Promise<void>((resolve) => { completed.set(id, resolve); });
  const text = "First\u2028second\u2029third: 🐙 日本語 café";
  const frame = (id: number, command: RuntimeCommand) => Buffer.from(JSON.stringify({ version: 1, id, command }));
  try {
    const configured = done(1);
    const bytes = frame(1, { type: "configure_coordinator", bootstrap: { node: null,
      settings: { model: DEFAULT_MODEL, instructions: text, context_repositories: [], sources: [] } } });
    for (const byte of bytes) child.stdin.write(Buffer.from([byte]));
    child.stdin.write("\r"); child.stdin.write("\n"); await configured;
    assert.equal(frames.some((value) => value.id === 0), false, "Literal Unicode separators must not split a JSON protocol frame");
    const snapshot = done(2); child.stdin.write(frame(2, { type: "environment", telemetry: false })); child.stdin.write("\n"); await snapshot;
    const environment = frames.find((value) => value.id === 2 && value.event.type === "environment")?.event;
    assert.ok(environment?.type === "environment"); assert.equal(environment.settings.instructions, text);
    child.stdin.end(frame(3, { type: "status" })); assert.equal(await closed, 0, errors);
    assert.equal(frames.some((value) => value.id === 0), false);
    assert.ok(frames.some((value) => value.id === 3 && value.event.type === "done"), "EOF retains the final unterminated frame");
    assert.equal(buffered.length, 0);
  } finally { child.kill(); await closed; await rm(directory, { recursive: true, force: true }); }
});


test("real bridge admits input before imported corpus catchup and interrupts a held semantic lookup", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-index-admission-")); await chmod(directory, 0o700);
  const harness = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models: builtinModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  try {
    const history = new HistoryStore(harness);
    await history.import({ host_id: "fixture-source", thread: { id: "retained-thread", title: "Connector context", cwd: "/example/project",
      created_at: 1, updated_at: 2, version: "one", version_reliable: true, archived: true, forked_from_id: null, parent_thread_id: null },
      items: [{ id: "old-user", turn_id: "one", kind: "userMessage", role: "user", text: "Connector decision from retained history.", version: "one",
        order: 0, timestamp_ms: 1, data: { type: "userMessage", text: "Connector decision from retained history." }, assets: [] }],
      next_cursor: null, gaps: [], complete: true });
  } finally { await harness.close(BACKGROUND_CONTEXT); }
  const queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({
    "fixture-before-index": [{ text: "The main chat is responsive before indexing." }],
    "fixture-held-search": [{ tool: "search_tasks", args: { query: "Connector retained history" } }],
    "fixture-after-index-stop": [{ text: "A new turn works after the lookup was interrupted." }],
  }));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout }); const frames: RuntimeEvent[] = [];
  const listeners = new Set<() => void>(); let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  lines.on("line", (line) => {
    const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame);
    if (frame.event.type === "host_call") {
      const command = frame.event.command;
      if (command.type === "reload_guidance") send(frame.id, { type: "host_reply", call_id: frame.event.call_id,
        result: { type: "shared_guidance", global: { text: "Brief fixture instructions.", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] } });
      else if (command.type === "project_guidance") send(frame.id, { type: "host_reply", call_id: frame.event.call_id,
        result: { type: "project_guidance", snapshot: { text: "", sources: [] } } });
    }
    for (const notify of listeners) notify();
  });
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const wait = (id: number, predicate: (event: RuntimeEventKind) => boolean): Promise<RuntimeEventKind> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Bridge did not finish request " + id + ": " + JSON.stringify(frames.map((frame) => ({ id: frame.id, event: frame.event }))) + errors)); }, 3000);
    const check = () => {
      const frame = frames.find((frame) => frame.id === id && predicate(frame.event));
      if (frame === undefined) return; clearTimeout(timer); listeners.delete(check); resolve(frame.event);
    };
    listeners.add(check); check();
  });
  const chat = (input: string, input_id: string): RuntimeCommand => ({ type: "chat", input, input_id, model: DEFAULT_MODEL, instructions: "Brief answers.",
    cwd: "/example/project", origin_host_id: null, hosts: [] });
  try {
    send(1, chat("fixture-before-index", "first-input"));
    const admission = await wait(1, (event) => ["input_placed", "host_call", "failure"].includes(event.type));
    assert.equal(admission.type, "input_placed", "Initial input must be saved before any embedding or corpus reconciliation host effect");
    await wait(1, (event) => event.type === "done");
    assert.ok(frames.some((frame) => frame.id === 1 && frame.event.type === "answer" && frame.event.text === "The main chat is responsive before indexing."));
    assert.equal(frames.some((frame) => frame.id === 1 && frame.event.type === "host_call" && frame.event.command.type === "embed"), false);
    send(2, chat("fixture-held-search", "lookup-input"));
    const held = await wait(2, (event) => (event.type === "host_call" && event.command.type === "embed") || event.type === "failure");
    assert.ok(held.type === "host_call" && held.command.type === "embed", "Explicit semantic search must still use the native embedding path");
    send(2, { type: "interrupt" });
    await wait(2, (event) => event.type === "done");
    assert.ok(frames.some((frame) => frame.id === 2 && frame.event.type === "host_cancel" && frame.event.call_id === held.call_id));
    assert.ok(frames.some((frame) => frame.id === 2 && frame.event.type === "interrupted"));
    send(3, chat("fixture-after-index-stop", "next-input"));
    await wait(3, (event) => event.type === "done");
    assert.ok(frames.some((frame) => frame.id === 3 && frame.event.type === "answer" && frame.event.text === "A new turn works after the lookup was interrupted."));
    assert.equal(frames.some((frame) => frame.event.type === "failure"), false, errors);
  } finally { lines.close(); child.stdin.end(); child.kill(); await closed; await rm(directory, { recursive: true, force: true }); }
});
