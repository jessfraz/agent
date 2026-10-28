import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import type { HistoryRequest } from "../src/generated/HistoryRequest.js";
import type { HistoryResponse } from "../src/generated/HistoryResponse.js";
import type { HistoryThread } from "../src/generated/HistoryThread.js";
import { HistoryStore, ImportedItemEntry } from "../src/history.js";
import { CodexImporter } from "../src/importer.js";
import type { HostCall } from "../src/tasks.js";

function node(host_id: string): AgentNode {
  return { host_id, name: host_id, rex_server: null, agent_program: "/example/agent", home_directory: "/example/home", coordinator: null,
    launch: { state_dir: null, runtime: null, config: null, instructions: null, model: null } };
}
const coordinator = node("coordinator"), laptop = node("laptop");
function thread(id: string, archived = false): HistoryThread {
  return { id, title: `Synthetic ${id}`, cwd: "/example/project", created_at: 1, updated_at: 2, forked_from_id: null,
    parent_thread_id: null, version: "native-v1", version_reliable: true, archived };
}
function item(id: string): HistoryItem {
  return { id, turn_id: "turn-one", kind: "userMessage", role: "user", text: `Saved evidence ${id}`, version: "item-v1", order: 0,
    timestamp_ms: 1, data: { type: "userMessage", content: [{ type: "text", text: `Saved evidence ${id}` }] }, assets: [] };
}
function page(source: HistoryThread, items: HistoryItem[], next_cursor: string | null = null): HistoryResponse {
  return { type: "read", thread_id: source.id, version: source.version, items, next_cursor, gaps: [], complete: next_cursor === null };
}
type Producer = (host: string, request: HistoryRequest) => HistoryResponse | Promise<HistoryResponse>;
function native(producer: Producer): HostCall {
  return async (command) => {
    if (command.type !== "on_node" || command.command.type !== "history") {
      throw new Error("An import attempted an operation other than a native history read");
    }
    return { type: "history", response: await producer(command.host_id, command.command.request) };
  };
}
async function open(directory: string) {
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const assets = join(directory, "assets"), histories = new HistoryStore(session, assets);
  const importer = new CodexImporter(session, histories, assets);
  let indexes = 0;
  return { session, histories, importer, assets, faux, indexCount: () => indexes,
    run: (producer: Producer, nodes = [coordinator]) => importer.run(nodes, nodes.map((node) => node.host_id), [], native(producer), () => {}, async () => { indexes += 1; }) };
}
async function originals(app: Awaited<ReturnType<typeof open>>, id: string) {
  const record = await app.histories.get(id); assert.ok(record);
  const conversation = await app.histories.conversation(record.conversation_id); assert.ok(conversation);
  const entries = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
  return { conversation, entries: entries.items.filter(ImportedItemEntry.is) };
}

test("the orchestrator imports active and archived history from both hosts without Rex sessions, model calls or duplicate entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-native-")); const app = await open(directory);
  try {
    const shared = thread("shared"), old = thread("archived", true), fork = { ...thread("fork", true), forked_from_id: shared.id };
    const listings = new Set<string>(); let reads = 0;
    const producer: Producer = (host, request) => {
      if (request.type === "list") {
        assert.equal(request.cursor, null); listings.add(`${host}:${request.archived}`);
        return { type: "list", threads: request.archived ? [host === coordinator.host_id ? old : fork] : [shared], next_cursor: null };
      }
      if (request.type !== "read") throw new Error("No media is present in this fixture");
      reads += 1; assert.equal(request.cursor, null);
      const source = [shared, old, fork].find((source) => source.id === request.thread_id); assert.ok(source);
      return page(source, [item(source.id)]);
    };
    const first = await app.run(producer, [coordinator, laptop]);
    assert.equal(first.phase, "complete"); assert.equal(first.threads_seen, 4);
    assert.equal(first.items_added, 3); assert.equal(first.items_unchanged, 1);
    assert.deepEqual([...listings].sort(), ["coordinator:false", "coordinator:true", "laptop:false", "laptop:true"]);
    assert.equal((await app.histories.get(fork.id))?.thread.forked_from_id, shared.id);
    const repeated = await app.run(producer, [coordinator, laptop]);
    assert.equal(repeated.phase, "complete"); assert.equal(repeated.threads_unchanged, 4); assert.equal(repeated.items_added, 0); assert.equal(reads, 4);
    assert.equal(app.indexCount(), 2);
    for (const source of [shared, old, fork]) {
      const saved = await originals(app, source.id); assert.equal(saved.entries.length, 1);
      assert.ok(saved.entries.every((entry) => entry.model === undefined));
      assert.deepEqual((await saved.conversation.context(BACKGROUND_CONTEXT)).messages, []);
    }
    assert.equal((await app.session.commit((tx) => tx.scanTasks({}, 100), BACKGROUND_CONTEXT)).items.length, 0);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an interrupted native page resumes its durable cursor after reopening Pi", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-resume-")); let app = await open(directory);
  try {
    const source = thread("paged"); let interrupt = true; const cursors: (string | null)[] = [];
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      if (request.type !== "read") throw new Error("No media is present in this fixture");
      cursors.push(request.cursor);
      if (request.cursor === null) return page(source, [item("first")], "page-two");
      assert.equal(request.cursor, "page-two");
      if (interrupt) throw new Error("Synthetic native page is temporarily unavailable");
      return page(source, [item("second")]);
    };
    assert.equal((await app.run(producer)).phase, "partial");
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.next_cursor, "page-two");
    assert.equal((await originals(app, source.id)).entries.length, 1);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory); interrupt = false; cursors.length = 0;
    const resumed = await app.run(producer);
    assert.equal(resumed.phase, "complete"); assert.equal(resumed.items_added, 1); assert.deepEqual(cursors, ["page-two"]);
    assert.equal((await originals(app, source.id)).entries.length, 2);
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.complete, true);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("inventory failures remain visible after the media gap summary fills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-coverage-")); const app = await open(directory);
  try {
    const active = thread("active-media"), archived = thread("archived-media", true);
    const producer: Producer = (_host, request) => {
      if (request.type === "list") {
        if (request.cursor !== null) throw new Error("Synthetic inventory failure");
        return { type: "list", threads: [request.archived ? archived : active], next_cursor: request.archived ? null : "next-page" };
      }
      if (request.type !== "read") throw new Error("No available media is present");
      const source = request.thread_id === active.id ? active : archived;
      const entries = Array.from({ length: source.archived ? 3 : 55 }, (_, index) => item(`${source.id}-${index}`));
      return { type: "read", thread_id: source.id, version: source.version,
        items: entries, next_cursor: null, complete: false,
        gaps: entries.map((entry) => ({ code: "missing", item_id: entry.id, message: "A referenced media asset is unavailable" })) };
    };
    const result = await app.run(producer);
    assert.equal(result.phase, "partial"); assert.equal(result.items_added, 58);
    assert.equal(result.gap_count, 59); assert.equal(result.gaps.length, 50);
    assert.equal(result.gaps[0], "coordinator: active inventory: Synthetic inventory failure");
    assert.equal((await app.histories.checkpoint(active.id, coordinator.host_id))?.gaps.length, 55);
    assert.equal((await app.histories.checkpoint(archived.id, coordinator.host_id))?.gaps.length, 3);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a concurrent rerun attaches to the existing native walk instead of starting a second import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-concurrent-")); const app = await open(directory);
  let release = () => {}, started = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const source = thread("shared-run"); let inventories = 0, reads = 0;
    const producer: Producer = async (_host, request) => {
      if (request.type === "list") {
        inventories += 1;
        if (!request.archived) { started(); await gate; }
        return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      }
      if (request.type !== "read") throw new Error("No media is present in this fixture");
      reads += 1; return page(source, [item("single-entry")]);
    };
    const first = app.run(producer); await began; assert.equal(app.importer.isRunning(), true);
    const second = app.run(producer); release();
    const results = await Promise.all([first, second]); assert.deepEqual(results[0], results[1]);
    assert.equal(results[0]?.phase, "complete"); assert.equal(inventories, 2); assert.equal(reads, 1); assert.equal(app.indexCount(), 1);
    assert.equal((await originals(app, source.id)).entries.length, 1); assert.equal(app.faux.state.callCount, 0);
    assert.equal(app.importer.isRunning(), false);
  } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("status reports a stopped import after reopening Pi and preserves its resumable page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-status-")); let app = await open(directory);
  let release = () => {}, entered = () => {};
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const source = thread("stopped");
  const abandoned = app.run(async (_host, request) => {
    if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
    if (request.type !== "read") throw new Error("No media is present");
    if (request.cursor === null) return page(source, [item("before-stop")], "second-page");
    entered(); await gate; throw new Error("Previous execution stopped");
  });
  void abandoned.catch(() => {});
  try {
    await waiting;
    const active = await app.importer.status(); assert.notEqual(active.phase, "partial");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const status = await app.importer.status(); assert.equal(status.phase, "partial");
    assert.equal(status.gaps[0], "Previous import was interrupted; run agent import codex to resume.");
    assert.deepEqual(await app.importer.status(), status);
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.next_cursor, "second-page");
    const resumed = await app.run((_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      if (request.type !== "read") throw new Error("No media is present");
      assert.equal(request.cursor, "second-page"); return page(source, [item("after-stop")]);
    });
    assert.equal(resumed.phase, "complete"); assert.equal(resumed.items_added, 1);
    assert.equal((await originals(app, source.id)).entries.length, 2);
  } finally { release(); await abandoned.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a failed chunked asset transfer leaves a gap and retries the same item version into private coordinator storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-assets-")); const app = await open(directory);
  try {
    const source = thread("media"); const evidence = item("with-media");
    const original = evidence.data, bytes = Buffer.from(JSON.stringify(original)); const digest = createHash("sha256").update(bytes).digest("hex");
    const locator = "/native/source/evidence.json"; evidence.data = null;
    evidence.assets = [{ path: locator, item_id: evidence.id, version: evidence.version, kind: "cold_evidence", media_type: "application/json", sha256: digest, size: bytes.length }];
    let fail = true, assetReads = 0;
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      if (request.type === "read") return page(source, [evidence]);
      assert.equal(request.thread_id, source.id); assert.equal(request.path, locator); assetReads += 1;
      if (fail && request.offset > 0) throw new Error("Synthetic asset read interrupted");
      const end = Math.min(bytes.length, request.offset + 17);
      return { type: "asset", path: locator, offset: request.offset, data_base64: bytes.subarray(request.offset, end).toString("base64"),
        next_offset: end === bytes.length ? null : end, total_bytes: bytes.length, sha256: digest };
    };
    const failed = await app.run(producer);
    assert.equal(failed.phase, "partial"); assert.equal(failed.items_added, 0); assert.ok(failed.gap_count > 0);
    assert.equal((await originals(app, source.id)).entries.length, 0); assert.deepEqual(await readdir(app.assets), []);
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.complete, false);
    fail = false; const recovered = await app.run(producer);
    assert.equal(recovered.phase, "complete"); assert.equal(recovered.items_added, 1); assert.equal(recovered.assets_saved, 1);
    const saved = await originals(app, source.id); assert.equal(saved.entries.length, 1);
    const entry = saved.entries[0]; assert.ok(entry);
    const asset = entry.data.item.assets[0]; assert.ok(asset); assert.equal(asset.path, join(app.assets, digest));
    assert.deepEqual(await readFile(asset.path), bytes); assert.equal((await stat(asset.path)).mode & 0o777, 0o600);
    assert.deepEqual(await app.histories.original(entry), original);
    const before = assetReads; const repeated = await app.run(producer);
    assert.equal(repeated.threads_unchanged, 1); assert.equal(assetReads, before);
    assert.equal((await originals(app, source.id)).entries.length, 1); assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("changed or unreliable first-read failures replace stale completeness before a native read can fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-first-read-")); const app = await open(directory);
  try {
    let advertised = thread("observed"), fail = false;
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [advertised], next_cursor: null };
      if (request.type !== "read") throw new Error("No media is present in this fixture");
      if (fail) throw new Error("Synthetic source lost access before its first page");
      return page(advertised, [item("retained")]);
    };
    assert.equal((await app.run(producer)).phase, "complete");
    for (const current of [{ ...advertised, version: "native-v2" }, { ...advertised, version: "native-v2", version_reliable: false }]) {
      advertised = current; fail = true;
      const failed = await app.run(producer); assert.equal(failed.phase, "partial");
      const checkpoint = await app.histories.checkpoint(current.id, coordinator.host_id);
      assert.ok(checkpoint); assert.equal(checkpoint.version, current.version); assert.equal(checkpoint.complete, false); assert.equal(checkpoint.next_cursor, null);
      assert.equal((await app.histories.get(current.id))?.complete, false);
      assert.equal((await originals(app, current.id)).entries.length, 1, "Previously retained source evidence remains available");
      fail = false; const recovered = await app.run(producer);
      assert.equal(recovered.phase, "complete"); assert.equal(recovered.items_added, 0); assert.equal(recovered.items_unchanged, 1);
    }
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
