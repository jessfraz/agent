import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";
import type { HistoryThread } from "../src/generated/HistoryThread.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import { HistoryStore } from "../src/history.js";
import { DEFAULT_MODEL } from "../src/models.js";
import { validEvent } from "../src/protocol.js";

type HostFrame = { id: number; event: Extract<RuntimeEventKind, { type: "host_call" }> };
const space: EmbeddingSpace = { id: "synthetic-import-search", model_revision: "fixture", model_digest: "fixture",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 };
function node(host_id: string, name: string): AgentNode {
  return { host_id, name, rex_server: null, agent_program: "/example/agent", home_directory: "/example/home", coordinator: null,
    launch: { state_dir: null, runtime: null, config: null, instructions: null, model: null } };
}
const storage = node("11111111-1111-4111-8111-111111111111", "storage");
const compute = node("22222222-2222-4222-8222-222222222222", "compute");
const source: HistoryThread = { id: "retained-thread", title: "Quartzfixture connector evidence", cwd: "/example/project",
  created_at: 1, updated_at: 2, version: "one", version_reliable: true, archived: false, forked_from_id: null, parent_thread_id: null };

test("native import indexes on the preferred worker, falls back and returns without moving source reads or foreground work", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-embedding-")); await chmod(directory, 0o700);
  const harness = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models: builtinModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  let conversation: string;
  try {
    // Distinct native chunks exercise several real index batches, rather than
    // invoking a copy of the routing callback with hand-written operations.
    const text = Array.from({ length: 2400 }, (_, n) =>
      `Quartzfixture connector section ${n}: pin ${n * 7} routes the independent sensor channel ${n * 13}.`).join("\n");
    const saved = await new HistoryStore(harness, join(directory, "history", "assets")).import({ host_id: storage.host_id, thread: source,
      items: [{ id: "native-user", turn_id: "one", kind: "userMessage", role: "user", text: "Quartzfixture connector evidence.", version: "one",
        order: 0, timestamp_ms: 1, data: { type: "userMessage", content: [{ type: "text", text }] }, assets: [] }],
      next_cursor: null, gaps: [], complete: true });
    conversation = saved.conversation.conversation_id;
  } finally { await harness.close(BACKGROUND_CONTEXT); }
  const queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({ "foreground-fixture": [{ text: "Foreground chat is responsive." }] }));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout }), frames: RuntimeEvent[] = [], calls: HostFrame[] = [];
  const listeners = new Set<() => void>(), handled = new Set<string>(); let errors = "", revision = 1;
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const reply = (frame: HostFrame, result: HostResult) => send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
  const embedded = (frame: HostFrame, descriptor = space) => {
    const command = frame.event.command.type === "on_node" ? frame.event.command.command : frame.event.command;
    assert.equal(command.type, "embed"); if (command.type !== "embed") throw new Error("Expected embedding operation");
    reply(frame, { type: "embeddings", batch: { space: descriptor, vectors: command.texts.map(() => [1, 0, 0]) } });
  };
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  lines.on("line", (line) => {
    const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame);
    if (frame.event.type === "host_call") {
      const host = { id: frame.id, event: frame.event }; calls.push(host);
      const command = frame.event.command;
      if (command.type === "reload_guidance") reply(host, { type: "shared_guidance", global: { text: "Brief fixture instructions.", sources: [] },
        workflow_policy: "", context_repositories: [], context_sources: [] });
      else if (command.type === "project_guidance") reply(host, { type: "project_guidance", snapshot: { text: "", sources: [] } });
      else if (command.type === "on_node" && command.command.type === "history") {
        const request = command.command.request;
        if (request.type === "list") reply(host, { type: "history", response: { type: "list", threads: revision === 1 || request.archived ? [] :
          [{ ...source, version: String(revision), updated_at: revision + 2 }], next_cursor: null } });
        else if (request.type === "read") reply(host, { type: "history", response: { type: "read", thread_id: source.id, version: String(revision),
          items: [{ id: "native-update", turn_id: "two", kind: "userMessage", role: "user", text: `Quartzfixture update ${revision}.`,
            version: String(revision), order: 1, timestamp_ms: revision + 2,
            data: { type: "userMessage", text: `Quartzfixture update ${revision}.` }, assets: [] }],
          next_cursor: null, gaps: [], complete: true, source_exhausted: true } });
      }
    }
    for (const notify of listeners) notify();
  });
  const wait = (id: number, predicate: (event: RuntimeEventKind) => boolean): Promise<RuntimeEvent> => new Promise((resolve, reject) => {
    function cleanup(): void { listeners.delete(check); t.signal.removeEventListener("abort", stopped); child.off("close", stopped); }
    function stopped(): void {
      cleanup(); reject(new Error(`Bridge stopped before request ${id}: ` + JSON.stringify(frames.map((frame) => ({ id: frame.id, type: frame.event.type }))) + errors));
    }
    function check(): void {
      const frame = frames.find((frame) => frame.id === id && predicate(frame.event));
      if (frame !== undefined) { cleanup(); resolve(frame); }
    }
    listeners.add(check); t.signal.addEventListener("abort", stopped, { once: true }); child.once("close", stopped);
    if (t.signal.aborted || child.exitCode !== null || child.signalCode !== null) stopped(); else check();
  });
  const next = async (id: number): Promise<HostFrame | undefined> => {
    const frame = await wait(id, (event) => event.type === "done" || (event.type === "host_call" &&
      !handled.has(event.call_id) && (event.command.type === "embed" || (event.command.type === "on_node" && event.command.command.type === "embed"))));
    if (frame.event.type === "done") return undefined;
    assert.equal(frame.event.type, "host_call"); if (frame.event.type !== "host_call") throw new Error("Expected host call");
    handled.add(frame.event.call_id); return { id: frame.id, event: frame.event };
  };
  const request = async (id: number, command: RuntimeCommand) => { send(id, command); await wait(id, (event) => event.type === "done"); };
  try {
    await request(1, { type: "configure_coordinator", bootstrap: { node: storage,
      settings: { model: DEFAULT_MODEL, instructions: "Brief fixture instructions.", context_repositories: [], sources: [] } } });
    await request(2, { type: "register_node", node: compute });
    await request(3, { type: "set_connected_nodes", host_ids: [storage.host_id, compute.host_id] });
    send(10, { type: "import_codex", hosts: [storage.name], embedding_host: "COMPUTE" });
    const first = await next(10); assert.ok(first); assert.equal(first.event.command.type, "on_node", "The actual index must dispatch its first batch to the selected worker");
    assert.ok(first.event.command.type === "on_node" && first.event.command.host_id === compute.host_id);
    send(20, { type: "chat", input: "foreground-fixture", input_id: "foreground-input", model: DEFAULT_MODEL, instructions: "Brief answers.",
      cwd: "/example/project", origin_host_id: null, hosts: [] });
    await wait(20, (event) => event.type === "done");
    assert.ok(frames.some((frame) => frame.id === 20 && frame.event.type === "input_placed"));
    assert.ok(frames.some((frame) => frame.id === 20 && frame.event.type === "answer" && frame.event.text === "Foreground chat is responsive."));
    assert.equal(frames.some((frame) => frame.id === 10 && frame.event.type === "done"), false, "Foreground work must finish while indexing is held");
    await request(4, { type: "set_connected_nodes", host_ids: [storage.host_id] }); embedded(first);
    const offline = await next(10); assert.ok(offline); assert.equal(offline.event.command.type, "embed", "A disconnected worker must not hold compute");
    await request(5, { type: "set_connected_nodes", host_ids: [storage.host_id, compute.host_id] }); embedded(offline);
    const returned = await next(10); assert.ok(returned); assert.equal(returned.event.command.type, "on_node");
    reply(returned, { type: "failed", message: "The owning node disconnected before its reply." });
    const fallback = await next(10); assert.ok(fallback); assert.equal(fallback.event.command.type, "embed");
    assert.ok(returned.event.command.type === "on_node"); assert.deepEqual(fallback.event.command, returned.event.command.command, "Lost pure compute is retried with the same batch locally"); embedded(fallback);
    const restored = await next(10); assert.ok(restored); assert.equal(restored.event.command.type, "on_node", "A failed batch must not make fallback sticky"); embedded(restored);
    for (let frame = await next(10); frame !== undefined; frame = await next(10)) embedded(frame);
    assert.ok(frames.some((frame) => frame.id === 10 && frame.event.type === "import_progress" && frame.event.progress.phase === "complete"));
    send(30, { type: "search_history", query: "Quartzfixture", limit: 8, mode: "keyword" });
    for (let frame = await next(30); frame !== undefined; frame = await next(30)) { assert.equal(frame.event.command.type, "embed"); embedded(frame); }
    const found = frames.find((frame) => frame.id === 30 && frame.event.type === "saved_matches")?.event;
    assert.ok(found?.type === "saved_matches" && found.matches.some((match) => match.conversation_id === conversation && match.imported?.thread.id === source.id));

    // A returned vector-space mismatch is an index error, never availability
    // fallback. Use the native ID selector on this new import.
    revision = 2; send(40, { type: "import_codex", hosts: [storage.host_id], embedding_host: compute.host_id });
    for (let frame = await next(40); frame !== undefined; frame = await next(40)) {
      assert.equal(frame.event.command.type, "on_node"); embedded(frame, { ...space, id: "incompatible-space" });
    }
    assert.ok(frames.some((frame) => frame.id === 40 && frame.event.type === "import_progress" && frame.event.progress.phase === "partial" &&
      frame.event.progress.gaps.some((gap) => gap.includes("Embedding space changed"))));
    assert.equal(calls.some((frame) => frame.id === 40 && frame.event.command.type === "embed"), false);

    revision = 3; send(50, { type: "import_codex", hosts: [storage.host_id] });
    let defaults = 0;
    for (let frame = await next(50); frame !== undefined; frame = await next(50)) { assert.equal(frame.event.command.type, "embed"); defaults += 1; embedded(frame); }
    assert.ok(defaults > 0, "Omitting the option retains coordinator indexing");
    send(60, { type: "search_history", query: "Quartzfixture", limit: 8, mode: "semantic" });
    let queries = 0;
    for (let frame = await next(60); frame !== undefined; frame = await next(60)) { assert.equal(frame.event.command.type, "embed"); queries += 1; embedded(frame); }
    assert.ok(queries > 0, "Foreground semantic search keeps its own coordinator compute");
    await request(70, { type: "import_codex", hosts: [storage.host_id], embedding_host: "unknown" });
    assert.ok(frames.some((frame) => frame.id === 70 && frame.event.type === "failure" && frame.event.code === "invalid_request"));
    assert.equal(calls.some((frame) => frame.id === 70), false, "Unknown hosts must fail before any source or indexing effect");
    assert.ok(calls.some((frame) => frame.event.command.type === "on_node" && frame.event.command.command.type === "history"));
    for (const frame of calls) {
      const command = frame.event.command;
      if (command.type === "on_node" && command.command.type === "history") assert.equal(command.host_id, storage.host_id);
      assert.ok(["embed", "on_node", "reload_guidance", "project_guidance"].includes(command.type), "Import must not allocate Rex workers");
    }
  } finally { lines.close(); child.stdin.end(); child.kill("SIGKILL"); await closed; await rm(directory, { recursive: true, force: true }); }
});
