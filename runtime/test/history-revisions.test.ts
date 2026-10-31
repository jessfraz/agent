import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDocFamily, Harness, type ConversationId, type Cursor, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import type { HistoryGap } from "../src/generated/HistoryGap.js";
import type { HistoryThread } from "../src/generated/HistoryThread.js";
import type { ImportedConversation } from "../src/generated/ImportedConversation.js";
import { HistoryStore, ImportedItemEntry, ImportedThreadEntry, importedText } from "../src/history.js";
import { CodexImporter } from "../src/importer.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { Retrieval } from "../src/retrieval.js";
import { SearchIndex } from "../src/search.js";
import { history } from "../src/transcript.js";

const thread: HistoryThread = { id: "source-thread", title: "Revision fixture", cwd: "/example", created_at: 1, updated_at: 10,
  forked_from_id: null, parent_thread_id: null, version: "thread-one", version_reliable: true, archived: true };
function item(text: string, version: string, id = "source-item", turn = "source-turn"): HistoryItem & { data: JsonValue } {
  return { id, turn_id: turn, kind: "userMessage", role: "user", order: 0, timestamp_ms: 1000, assets: [], text, version,
    data: { type: "userMessage", content: [{ type: "text", text }] } };
}
const old = item("Obsidianoldonly prior decision", "item-one"), current = item("Zirconianewonly corrected decision", "item-two");
async function open(directory: string) {
  const models = createModels();
  const storage = await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite")));
  const session = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const store = new HistoryStore(session), tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(store);
  const embedded: string[] = [];
  const embed: HostCall = async (command) => {
    assert.equal(command.type, "embed"); if (command.type !== "embed") throw new Error("Unexpected effect");
    embedded.push(...command.texts);
    return { type: "embeddings", batch: { space: { id: "synthetic-revisions", model_revision: "one", model_digest: "one", dimensions: 3,
      pooling: "last", normalization: "l2", instruction_version: 1 }, vectors: command.texts.map(() => [1, 0, 0]) } };
  };
  const retrieval = new Retrieval(session, store, tasks, join(directory, "search.sqlite"));
  return { session, storage, store, tasks, retrieval, embedded, embed,
    async close() { retrieval.close(); await session.close(BACKGROUND_CONTEXT); } };
}
type App = Awaited<ReturnType<typeof open>>;
async function save(app: App, items: HistoryItem[], at = 10, version = "thread-one", extra: { host?: string; cursor?: string | null } = {}) {
  return app.store.import({ host_id: extra.host ?? "source-host", thread: { ...thread, updated_at: at, version }, items,
    next_cursor: extra.cursor ?? null, gaps: [], complete: extra.cursor === undefined || extra.cursor === null });
}
async function rows(app: App, id: string) {
  const conversation = await app.store.conversation(id); assert.ok(conversation);
  const frames = await history(conversation, null, app.session);
  return frames.flatMap((frame) => frame.messages);
}
async function nativeEntries(app: App, id: string) {
  const conversation = await app.store.conversation(id); assert.ok(conversation);
  let cursor: Cursor | undefined; const entries: EntryRecord[] = [];
  do { const page = await conversation.entries({ order: "ascending" }, 100, cursor, BACKGROUND_CONTEXT); entries.push(...page.items); cursor = page.next; } while (cursor !== undefined);
  return entries;
}
async function originals(app: App, id: string) { return (await nativeEntries(app, id)).filter(ImportedItemEntry.is); }
async function lexical(directory: string, query: string) {
  const index = new SearchIndex(join(directory, "search.sqlite"));
  try { return await index.search(query, undefined, [], 4, "keyword"); } finally { index.close(); }
}

test("native source timestamps select one revision across stale-host order, restart, history and actual search", async (t) => {
  for (const order of ["stale first", "current first", "concurrent"]) await t.test(order, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-revision-order-")); let app = await open(directory);
    try {
      const stale = { value: old, at: 10 }, fresh = { value: current, at: 20 };
      const observations = order === "stale first" ? [stale, fresh] : [fresh, stale];
      let id = "";
      const observe = async ({ value, at }: typeof stale) => (await save(app, [value], at, "thread-" + at, { host: "host-" + at })).conversation.conversation_id;
      if (order === "concurrent") { const ids = await Promise.all(observations.map(observe)); assert.equal(new Set(ids).size, 1); id = ids[0] ?? ""; }
      else for (const observation of observations) id = await observe(observation);
      assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text]);
      const retained = await originals(app, id); assert.equal(retained.length, 2);
      await app.retrieval.sync(app.embed, true);
      assert.equal((await lexical(directory, "Obsidianoldonly")).candidates.length, 0);
      assert.ok((await app.retrieval.search("Obsidianoldonly", [], 4, app.embed, false, "keyword")).candidates.every((candidate) => candidate.matches.every((match) => match.text !== old.text)));
      assert.equal((await app.retrieval.search("Zirconianewonly", [], 4, app.embed, false, "keyword")).candidates.length, 1);
      assert.doesNotMatch(await app.tasks.readConversation(id), /Obsidianoldonly/u);
      const repeat = await save(app, [old], 10, "thread-10", { host: "host-10" }); assert.deepEqual(repeat.entry_ids, []);
      await app.close(); app = await open(directory);
      assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text]);
      assert.deepEqual(await originals(app, id), retained);
      assert.equal((await app.session.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test("a concurrent source publication cannot erase the older bounded history snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-snapshot-")); const app = await open(directory);
  try {
    const seeded = await save(app, [old]), id = seeded.conversation.conversation_id;
    const conversation = await app.store.conversation(id); assert.ok(conversation);
    const entries = conversation.entries.bind(conversation); let injected = false;
    conversation.entries = async (query, limit, cursor, context) => {
      const page = await entries(query, limit, cursor, context);
      if (limit === 20 && !injected) { injected = true; await save(app, [current], 20, "concurrent-source"); }
      return page;
    };
    const snapshot = (await history(conversation, null, app.session)).flatMap((frame) => frame.messages);
    assert.equal(injected, true);
    assert.deepEqual(snapshot.filter((row) => row.role === "user").map((row) => row.text), [old.text]);
    assert.ok(snapshot.some((row) => row.role === "notice" && /coverage is unverified/u.test(row.text)));
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text]);
    const lookup = app.tasks.conversation.bind(app.tasks);
    app.tasks.conversation = async (value) => value === id ? conversation : lookup(value);
    conversation.entries = async (query, limit, cursor, context) => {
      const page = await entries(query, limit, cursor, context);
      if (limit === 100) { conversation.entries = entries; await save(app, [item("Third source revision", "item-three")], 30, "third-source"); }
      return page;
    };
    const context = await app.tasks.readConversation(id);
    assert.match(context, /Zirconianewonly/u); assert.match(context, /coverage is unverified/u);
    assert.doesNotMatch(context, /Third source revision/u);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a superseded source tail returns a bounded empty page and continuation instead of scanning to a visible row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-hidden-tail-")); const app = await open(directory);
  try {
    const fresh = Array.from({ length: 1000 }, (_, index) => item("Current source item " + index, "fresh", "item-" + index));
    const stale = fresh.map((value) => ({ ...value, text: "Stale source item", version: "stale", data: { type: "userMessage", text: "Stale source item" } }));
    const saved = await save(app, fresh, 20, "new-source"), id = saved.conversation.conversation_id;
    await save(app, stale, 10, "old-source", { host: "stale-host" });
    const conversation = await app.store.conversation(id); assert.ok(conversation);
    let scanned = 0; const scan = app.storage.scanEntries.bind(app.storage);
    app.storage.scanEntries = async (query, limit, cursor, context) => { const page = await scan(query, limit, cursor, context); scanned += page.items.length; return page; };
    const initial = await history(conversation, null, app.session);
    assert.ok(scanned <= 23, `The first page read ${scanned} native rows`);
    assert.equal(initial.flatMap((frame) => frame.messages).length, 0);
    let cursor = initial.at(-1)?.next_cursor; assert.ok(cursor);
    app.storage.scanEntries = scan;
    let visible = false;
    while (cursor !== null && cursor !== undefined && !visible) {
      const page = await history(conversation, cursor, app.session);
      visible = page.some((frame) => frame.messages.some((message) => message.role === "user"));
      cursor = page.at(-1)?.next_cursor;
    }
    assert.equal(visible, true);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("equal native timestamps preserve explicit ambiguity until a strictly newer observation resolves it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-equal-")); let app = await open(directory);
  try {
    const first = await save(app, [old], 10, "equal-source-a"), id = first.conversation.conversation_id;
    await save(app, [current], 10, "equal-source-b", { host: "another-host" });
    let messages = await rows(app, id);
    assert.deepEqual(messages.filter((row) => row.role === "user").map((row) => row.text), [old.text, current.text]);
    assert.equal(messages.filter((row) => row.role === "notice" && /Conflicting historical revisions/u.test(row.text)).length, 2);
    await app.retrieval.sync(app.embed, true);
    assert.ok((await app.retrieval.search("Obsidianoldonly", [], 4, app.embed, false, "keyword")).gaps.some((gap) => /equal or unverified/u.test(gap)));
    const before = await originals(app, id);
    await app.close(); app = await open(directory);
    assert.equal((await rows(app, id)).filter((row) => row.role === "notice").length, 2);
    const resolved = await save(app, [current], 20, "strictly-newer"); assert.equal(resolved.added_items, 0);
    messages = await rows(app, id);
    assert.deepEqual(messages.filter((row) => row.role === "user").map((row) => row.text), [current.text]);
    assert.equal(messages.filter((row) => row.role === "notice").length, 0);
    assert.deepEqual(await originals(app, id), before);
    await app.retrieval.sync(app.embed, true);
    assert.equal((await lexical(directory, "Obsidianoldonly")).candidates.length, 0);
    const stable = await save(app, [current], 20, "strictly-newer"); assert.deepEqual(stable.entry_ids, []);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("same-host same-second captures replace revisions through the native importer and remain stable after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-same-second-")); let app = await open(directory);
  const node = { host_id: "source-host", name: "source-host", rex_server: null, agent_program: "agent", home_directory: "/example", coordinator: null,
    launch: { state_dir: null, runtime: null, config: null, instructions: null, model: null } };
  let metadata = { ...thread, version: "first-reliable-snapshot" }, values = [old], reads = 0, changedDuringRead = false;
  const call: HostCall = async (command) => {
    assert.ok(command.type === "on_node" && command.command.type === "history");
    const request = command.command.request;
    if (request.type === "list") return { type: "history", response: { type: "list", threads: request.archived ? [] : [metadata], next_cursor: null } };
    assert.equal(request.type, "read"); reads += 1;
    return { type: "history", response: { type: "read", thread_id: thread.id,
      version: changedDuringRead ? "native-page-snapshot" : metadata.version, items: values, next_cursor: null, gaps: [], complete: true, source_exhausted: true } };
  };
  const run = () => new CodexImporter(app.session, app.store, join(directory, "assets")).run([node], [node.host_id], [node.host_id], call, () => {}, () => app.retrieval.sync(app.embed, true));
  try {
    await run(); const record = await app.store.get(thread.id); assert.ok(record); const id = record.conversation_id;
    await app.close(); app = await open(directory);
    metadata = { ...metadata, version: "later-same-second-snapshot" }; values = [current]; changedDuringRead = true;
    await run(); assert.equal(reads, 2);
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text]);
    assert.equal((await lexical(directory, "Obsidianoldonly")).candidates.length, 0);
    assert.equal((await app.store.checkpoint(thread.id, node.host_id))?.version, "native-page-snapshot");
    const before = await nativeEntries(app, id);
    await app.close(); app = await open(directory);
    metadata = { ...metadata, version: "native-page-snapshot" }; changedDuringRead = false;
    await run(); assert.equal(reads, 2, "A completed snapshot replay must not become a newer capture");
    assert.deepEqual(await nativeEntries(app, id), before); assert.equal((await originals(app, id)).length, 2);
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a provisional advertised snapshot yields to its own already-known native read and stays resumable after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-known-read-")); let app = await open(directory);
  const node = { host_id: "source-host", name: "source-host", rex_server: null, agent_program: "agent", home_directory: "/example", coordinator: null,
    launch: { state_dir: null, runtime: null, config: null, instructions: null, model: null } };
  let advertised = "known-native", reads = 0;
  const call: HostCall = async (command) => {
    assert.ok(command.type === "on_node" && command.command.type === "history"); const request = command.command.request;
    if (request.type === "list") return { type: "history", response: { type: "list", threads: request.archived ? [] : [{ ...thread, version: advertised }], next_cursor: null } };
    assert.equal(request.type, "read"); reads += 1;
    return { type: "history", response: { type: "read", thread_id: thread.id, version: "known-native", items: [current], next_cursor: null, gaps: [], complete: true, source_exhausted: true } };
  };
  const run = () => new CodexImporter(app.session, app.store, join(directory, "assets")).run([node], [node.host_id], [node.host_id], call, () => {}, async () => {});
  try {
    await run(); advertised = "provisional-inventory"; await run();
    assert.equal(reads, 2);
    assert.equal((await app.store.checkpoint(thread.id, node.host_id))?.version, "known-native");
    assert.equal((await app.store.checkpoint(thread.id, node.host_id))?.complete, true);
    const record = await app.store.get(thread.id); assert.ok(record); assert.equal(record.thread.version, "known-native");
    await app.close(); app = await open(directory); advertised = "known-native";
    await run(); assert.equal(reads, 2, "The confirmed known snapshot must skip another source read");
    assert.equal((await originals(app, record.conversation_id)).length, 1);
    const conflicting = await app.store.capture(node.host_id, { ...thread, version: "provisional-inventory" }, true); assert.ok(conflicting);
    const confirmed = await app.store.rebindCapture(conflicting, { ...thread, version: "known-native" }); assert.ok(confirmed);
    const wrong = await app.store.rebindCapture(conflicting, { ...thread, version: "provisional-inventory" }); assert.equal(wrong, null,
      "A late reply cannot turn the same capture into two confirmed snapshots");
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("same-host causal replacement does not erase a conflicting equal-time observation on another host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-cross-host-")); const app = await open(directory);
  try {
    const seeded = await save(app, [old], 10, "snapshot-a"), id = seeded.conversation.conversation_id;
    await save(app, [current], 10, "snapshot-b");
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text]);
    await save(app, [old], 10, "snapshot-a", { host: "another-host" });
    assert.equal((await rows(app, id)).filter((row) => row.role === "notice").length, 2);
    await save(app, [current], 10, "snapshot-b", { host: "another-host" });
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text]);
    assert.equal((await originals(app, id)).length, 2);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("empty targeted retry pages retain their confirmed capture and new cursor across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-empty-retry-")); let app = await open(directory);
  const node = { host_id: "source-host", name: "source-host", rex_server: null, agent_program: "agent", home_directory: "/example", coordinator: null,
    launch: { state_dir: null, runtime: null, config: null, instructions: null, model: null } };
  const first = item("First retained text", "first", "first"), second = item("Second retained text", "second", "second");
  const missing = (id: string): HistoryGap => ({ code: "missing", item_id: id, message: "Referenced media is missing" });
  let stage = 0; const reads: (string | null)[] = [];
  const call: HostCall = async (command) => {
    assert.ok(command.type === "on_node" && command.command.type === "history"); const request = command.command.request;
    if (request.type === "list") return { type: "history", response: { type: "list", threads: request.archived ? [] : [thread], next_cursor: null } };
    assert.equal(request.type, "read"); if (request.type !== "read") throw new Error("No asset transfer is expected");
    reads.push(request.cursor);
    const values = request.cursor === null ? [first] : stage === 0 || stage === 2 ? [second] : [];
    const next = request.cursor === null ? "second-page" : stage === 1 && request.cursor === "second-page" ? "moved-page" : null;
    return { type: "history", response: { type: "read", thread_id: thread.id, version: thread.version, items: values, next_cursor: next,
      gaps: request.cursor === null ? [missing(first.id)] : stage === 0 ? [missing(second.id)] : [], complete: false, source_exhausted: next === null } };
  };
  const run = () => new CodexImporter(app.session, app.store, join(directory, "assets")).run([node], [node.host_id], [node.host_id], call, () => {}, async () => {});
  try {
    await run(); const record = await app.store.get(thread.id); assert.ok(record);
    await app.close(); app = await open(directory); stage = 1; reads.length = 0;
    await run(); assert.deepEqual(reads, [null, "second-page", "moved-page"]);
    const checkpoint = await app.store.checkpoint(thread.id, node.host_id); assert.ok(checkpoint);
    assert.deepEqual(checkpoint.retry_pages?.map((page) => page.cursor), [null, "moved-page"]);
    assert.ok(checkpoint.gaps.some((gap) => gap.item_id === null && gap.code === "unavailable"));
    await app.close(); app = await open(directory); stage = 2; reads.length = 0;
    await run(); assert.deepEqual(reads, [null, "moved-page"]);
    assert.equal((await originals(app, record.conversation_id)).length, 2);
    assert.deepEqual((await app.store.checkpoint(thread.id, node.host_id))?.retry_pages?.map((page) => page.cursor), [null]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("delayed pages retain their original host epoch across partial snapshots, restart and known-version replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-delayed-page-")); let app = await open(directory);
  try {
    const older = { ...thread, version: "capture-old" }, newer = { ...thread, version: "capture-new" };
    const oldCapture = await app.store.capture("source-host", older, true); assert.ok(oldCapture);
    const other = item("Original second page", "other-old", "another-item");
    const batch = (source: HistoryThread, items: HistoryItem[], cursor: string | null = null) => ({ host_id: "source-host", thread: source,
      items, next_cursor: cursor, gaps: [], complete: cursor === null });
    const seeded = await app.store.import(batch(older, [old, other]), oldCapture), id = seeded.conversation.conversation_id;
    const newCapture = await app.store.capture("source-host", newer, true); assert.ok(newCapture);
    await app.store.import(batch(newer, [current], "second-page"), newCapture);
    await app.store.import(batch(older, [old, other]), oldCapture);
    assert.equal((await app.store.checkpoint(thread.id, "source-host"))?.version, newer.version);
    assert.equal((await app.store.checkpoint(thread.id, "source-host"))?.next_cursor, "second-page");
    await app.close(); app = await open(directory);
    const resumed = await app.store.capture("source-host", newer, true); assert.ok(resumed);
    assert.equal(resumed.snapshot.sequence, newCapture.snapshot.sequence);
    const otherNew = item("Current second page", "other-new", "another-item");
    await app.store.import(batch(newer, [otherNew]), resumed);
    await app.store.import(batch(older, [old, other]), oldCapture);
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [current.text, otherNew.text]);
    assert.equal((await app.store.get(thread.id))?.thread.version, newer.version);
    assert.equal((await app.store.checkpoint(thread.id, "source-host"))?.complete, true);
    const before = await nativeEntries(app, id);
    await app.store.import(batch(newer, [current, otherNew]), resumed);
    assert.deepEqual(await nativeEntries(app, id), before);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an overlapping unadvertised page fingerprint remains ambiguous instead of gaining arrival-time authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-overlap-")); const app = await open(directory);
  try {
    const before = await app.store.capture("source-host", { ...thread, version: "first-inventory" }, true); assert.ok(before);
    const newer = { ...thread, version: "newer-inventory" }, later = await app.store.capture("source-host", newer, true); assert.ok(later);
    const seeded = await app.store.import({ host_id: "source-host", thread: newer, items: [current], next_cursor: null, gaps: [], complete: true }, later);
    const unadvertised = { ...thread, version: "unadvertised-page" };
    const unknown = await app.store.rebindCapture(before, unadvertised); assert.equal(unknown, null);
    await app.store.import({ host_id: "source-host", thread: unadvertised, items: [old], next_cursor: null, gaps: [], complete: true }, unknown);
    assert.equal((await rows(app, seeded.conversation.conversation_id)).filter((row) => row.role === "notice").length, 2);
    assert.equal((await app.store.checkpoint(thread.id, "source-host"))?.version, newer.version);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("page observations advance only seen items and survive restart before a later stale revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-pages-")); let app = await open(directory);
  try {
    const other = item("Unseen page keeps its prior evidence", "other-one", "another-item");
    const saved = await save(app, [old, other]), id = saved.conversation.conversation_id;
    await save(app, [old], 30, "partial-source", { cursor: "remaining-page" });
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [old.text, other.text]);
    assert.equal((await app.store.checkpoint(thread.id, "source-host"))?.next_cursor, "remaining-page");
    await app.close(); app = await open(directory);
    await save(app, [current], 20, "stale-missing-page", { host: "stale-host" });
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [old.text, other.text]);
    const otherNew = item("Newly read second page evidence", "other-two", "another-item");
    await save(app, [otherNew], 30, "partial-source");
    assert.deepEqual((await rows(app, id)).filter((row) => row.role === "user").map((row) => row.text), [old.text, otherNew.text]);
    assert.equal((await app.store.checkpoint(thread.id, "source-host"))?.complete, true);
    assert.equal((await originals(app, id)).length, 4);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy history renders a bounded page, then migrates its published vectors without a reset or guessed authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-revision-legacy-")); let app = await open(directory);
  const LegacyThreads = defineDocFamily<{ native_id: ConversationId | null; record: ImportedConversation | null; watermark: EntryId | null; evidence: string | null }, null>({
    kind: "agent.history.threads", scope: "session", family: true, version: 1,
    initial: () => ({ native_id: null, record: null, watermark: null, evidence: null }), checkpointWhen: () => true });
  const LegacyRevisions = defineDocFamily<{ watermark: EntryId | null; entries: Record<string, "superseded" | "ambiguous"> }, null>({
    kind: "agent.history.revisions", scope: "session", family: true, version: 1,
    initial: () => ({ watermark: null, entries: {} }), checkpointWhen: () => true });
  try {
    const seeded = await save(app, []), id = seeded.conversation.conversation_id;
    const conversation = await app.store.conversation(id); assert.ok(conversation);
    const latest = { ...thread, updated_at: 20, version: "legacy-newer" };
    await app.session.commit(async (tx) => {
      await tx.appendEntry(ImportedItemEntry, conversation.id, { data: { source: "codex", thread_id: thread.id, item: old } });
      for (let index = 0; index < 5000; index += 1) await tx.appendEntry(ImportedItemEntry, conversation.id, { data: { source: "codex", thread_id: thread.id,
        item: item("Legacy fixture row " + index, "one", "legacy-" + index) } });
      await tx.appendEntry(ImportedThreadEntry, conversation.id, { data: { source: "codex", thread: latest } });
      const entry = await tx.appendEntry(ImportedItemEntry, conversation.id, { data: { source: "codex", thread_id: thread.id, item: current } });
      const key = createHash("sha256").update(JSON.stringify(["codex", thread.id])).digest("hex");
      const state = await tx.doc(LegacyThreads, key, null);
      state.watermark = entry.id; state.record = { ...seeded.conversation, thread: latest };
      // The old producer had no derived revision certificate.
      const projection = await tx.doc(LegacyRevisions, key, null); projection.watermark = null; projection.entries = {};
    }, BACKGROUND_CONTEXT);
    await app.close(); app = await open(directory);
    let readEntries = 0;
    const nativeScan = app.storage.scanEntries.bind(app.storage);
    app.storage.scanEntries = async (query, limit, cursor, context) => { const page = await nativeScan(query, limit, cursor, context); readEntries += page.items.length; return page; };
    const initial = await rows(app, id);
    assert.ok(readEntries <= 23, "Opening legacy history must read only its head and bounded page");
    assert.equal(initial.filter((row) => row.role === "notice" && /coverage is unverified/u.test(row.text)).length, 1);
    app.storage.scanEntries = nativeScan;
    const index = new SearchIndex(join(directory, "search.sqlite"));
    const native = await nativeEntries(app, id), all = native.filter(ImportedItemEntry.is);
    async function* legacyRecords() { for (const entry of native) { const text = importedText(entry); if (text !== undefined) yield { entry_id: entry.id.toString(), ordinal: entry.id, text, source_refs: [] }; } }
    const embed = async (texts: string[]) => { const response = await app.embed({ type: "embed", texts, purpose: "document" }); assert.ok(response.type === "embeddings"); return response.batch; };
    const reopened = await app.store.conversation(id); assert.ok(reopened);
    const watermark = (await reopened.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]; assert.ok(watermark);
    await index.upsert(id, watermark.id.toString(), legacyRecords(), embed); index.close();
    const previous = new DatabaseSync(join(directory, "search.sqlite"));
    previous.prepare("DELETE FROM metadata WHERE key=?").run("source_projection");
    previous.exec("ALTER TABLE conversations DROP COLUMN gaps"); previous.close();
    const embeddedBefore = app.embedded.length;
    await app.retrieval.sync(app.embed, true);
    assert.equal(app.embedded.length, embeddedBefore, "Projection migration must reuse published vector bytes");
    const uncertain = await app.retrieval.search("Obsidianoldonly", [], 4, app.embed, false, "keyword");
    assert.ok(uncertain.gaps.some((gap) => /equal or unverified/u.test(gap)));
    await save(app, [current], 20, latest.version);
    await app.retrieval.sync(app.embed, true);
    assert.equal((await lexical(directory, "Obsidianoldonly")).candidates.length, 0);
    assert.equal((await originals(app, id)).length, all.length);
    await app.close(); app = await open(directory);
    const tail = await rows(app, id); assert.equal(tail.filter((row) => row.text === old.text).length, 0);
    assert.equal(tail.filter((row) => row.text === current.text).length, 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
