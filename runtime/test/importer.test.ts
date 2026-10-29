import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import type { HistoryGap } from "../src/generated/HistoryGap.js";
import type { HistoryRequest } from "../src/generated/HistoryRequest.js";
import type { HistoryResponse } from "../src/generated/HistoryResponse.js";
import type { HistoryThread } from "../src/generated/HistoryThread.js";
import type { ImportProgress } from "../src/generated/ImportProgress.js";
import type { HostResult } from "../src/generated/HostResult.js";
import { HistoryStore, ImportedItemEntry } from "../src/history.js";
import { CodexImporter } from "../src/importer.js";
import { ConversationModels } from "../src/models.js";
import { Retrieval } from "../src/retrieval.js";
import { SearchIndex } from "../src/search.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { HostRequests } from "../src/tools.js";
import { transcript } from "../src/transcript.js";

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
  return { type: "read", thread_id: source.id, version: source.version, items, next_cursor, gaps: [], complete: next_cursor === null,
    source_exhausted: next_cursor === null };
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
  return { session, histories, importer, assets, models, faux, indexCount: () => indexes,
    run: (producer: Producer, nodes = [coordinator]) => importer.run(nodes, nodes.map((node) => node.host_id), [], native(producer), () => {}, async () => { indexes += 1; }) };
}
async function originals(app: Awaited<ReturnType<typeof open>>, id: string) {
  const record = await app.histories.get(id); assert.ok(record);
  const conversation = await app.histories.conversation(record.conversation_id); assert.ok(conversation);
  const entries = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
  return { conversation, entries: entries.items.filter(ImportedItemEntry.is) };
}

test("unchanged partial imports retry only affected source pages across reopen and opaque page boundary changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-page-retry-")); let app = await open(directory);
  try {
    const source = thread("paged-media"), first = item("first"), tail = item("tail"), one = item("media-one"), two = item("media-two");
    const bytes = Buffer.from("synthetic media"), sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const entry of [one, two]) entry.assets = [{ path: "/source/" + entry.id, item_id: entry.id, version: entry.version,
      kind: "local_media", media_type: "image/png", sha256, size: bytes.length }];
    let available = false, readFailure = false; const reads: (string | null)[] = [];
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      if (request.type === "asset") {
        if (!available) throw new Error("Synthetic unavailable attachment");
        return { type: "asset", path: request.path, offset: request.offset, data_base64: bytes.toString("base64"), next_offset: null, total_bytes: bytes.length, sha256 };
      }
      reads.push(request.cursor);
      if (request.cursor === null) return page(source, [first], "opaque-media");
      if (request.cursor === "opaque-media" && readFailure) return { ...page(source, []), complete: false, source_exhausted: false,
        gaps: [{ code: "unavailable", item_id: null, message: "Synthetic retry page unavailable" }] };
      if (request.cursor === "opaque-media") return page(source, available ? [one] : [one, two], available ? "opaque-media-split" : "opaque-tail");
      if (request.cursor === "opaque-media-split") return page(source, [two], "opaque-tail");
      assert.equal(request.cursor, "opaque-tail"); return page(source, [tail]);
    };
    const initial = await app.run(producer); assert.equal(initial.phase, "partial"); assert.equal(initial.items_added, 4);
    assert.deepEqual(reads, [null, "opaque-media", "opaque-tail"]);
    const before = await originals(app, source.id); assert.equal(before.entries.length, 4);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory); reads.length = 0;
    readFailure = true;
    const blocked = await app.run(producer); assert.equal(blocked.phase, "partial"); assert.equal(blocked.gap_count, 3);
    assert.deepEqual(reads, ["opaque-media"]);
    readFailure = false; reads.length = 0;
    const repeated = await app.run(producer);
    assert.deepEqual(reads, ["opaque-media"], "Unchanged text outside the failed asset page must not be read again");
    assert.equal(repeated.phase, "partial"); assert.equal(repeated.items_added, 0); assert.equal(repeated.gap_count, 2);
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.source_exhausted, true);
    available = true; reads.length = 0;
    const recovered = await app.run(producer);
    assert.deepEqual(reads, ["opaque-media", "opaque-media-split"], "Only enough native pages to find the affected item IDs may be retried");
    assert.equal(recovered.phase, "complete"); assert.equal(recovered.items_added, 0); assert.equal(recovered.items_unchanged, 2);
    assert.equal(recovered.gap_count, 0); assert.equal(recovered.assets_saved, 2);
    assert.equal((await originals(app, source.id)).conversation.id, before.conversation.id);
    assert.deepEqual((await originals(app, source.id)).entries, before.entries);
    const saved = await app.histories.get(source.id); assert.equal(saved?.complete, true); assert.deepEqual(saved.gaps, []);
    const checkpoint = await app.histories.checkpoint(source.id, coordinator.host_id);
    assert.equal(checkpoint?.complete, true); assert.deepEqual(checkpoint.retry_pages, []);
    reads.length = 0; assert.equal((await app.run(producer)).threads_unchanged, 1); assert.deepEqual(reads, []);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a legacy partial checkpoint with media gaps receives one conservative scan before targeted retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-legacy-page-retry-")); const app = await open(directory);
  try {
    const source = thread("legacy-pages"), first = item("first"), media = item("media"), tail = item("tail");
    const gaps = [{ code: "missing", item_id: media.id, message: "A referenced media asset is unavailable" } satisfies HistoryGap];
    await app.histories.import({ host_id: coordinator.host_id, thread: source, items: [first, media], next_cursor: "legacy-tail", complete: false, gaps });
    const reads: (string | null)[] = [];
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      assert.equal(request.type, "read"); if (request.type !== "read") throw new Error("No transferable assets in this fixture");
      reads.push(request.cursor);
      if (request.cursor === null) return page(source, [first], "legacy-media");
      if (request.cursor === "legacy-media") return { ...page(source, [media], "legacy-tail"), gaps };
      assert.equal(request.cursor, "legacy-tail"); return page(source, [tail]);
    };
    assert.equal((await app.run(producer)).phase, "partial"); assert.deepEqual(reads, [null, "legacy-media", "legacy-tail"]);
    reads.length = 0;
    assert.equal((await app.run(producer)).phase, "partial"); assert.deepEqual(reads, ["legacy-media"]);
    assert.equal((await originals(app, source.id)).entries.length, 3);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a failed native read keeps its unread cursor and clears that read gap after successful continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-read-gap-")); const app = await open(directory);
  try {
    const source = thread("source-read-failure"); let fail = true; const reads: (string | null)[] = [];
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      assert.equal(request.type, "read"); if (request.type !== "read") throw new Error("No media in this fixture");
      reads.push(request.cursor);
      if (request.cursor === null) return page(source, [item("before-failure")], "unread-native-page");
      assert.equal(request.cursor, "unread-native-page");
      if (fail) return { ...page(source, []), complete: false, source_exhausted: false,
        gaps: [{ code: "unavailable", item_id: null, message: "Synthetic source read failure" }] };
      return page(source, [item("after-failure")]);
    };
    assert.equal((await app.run(producer)).phase, "partial");
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.next_cursor, "unread-native-page");
    fail = false; reads.length = 0;
    const recovered = await app.run(producer); assert.equal(recovered.phase, "complete"); assert.equal(recovered.items_added, 1);
    assert.deepEqual(reads, ["unread-native-page"]); assert.equal(recovered.gap_count, 0);
    assert.deepEqual((await app.histories.get(source.id))?.gaps, []); assert.equal((await originals(app, source.id)).entries.length, 2);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("changed and unreliable source versions scan safely instead of reusing a prior asset-only retry plan", async (t) => {
  for (const changed of [true, false]) await t.test(changed ? "changed metadata and title" : "unreliable locator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-import-retry-version-")); const app = await open(directory);
    try {
      let source = thread("versioned-media"), fail = true; const reads: (string | null)[] = [];
      const producer: Producer = (_host, request) => {
        if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
        assert.equal(request.type, "read"); if (request.type !== "read") throw new Error("No retained media in this fixture");
        reads.push(request.cursor);
        if (request.cursor === null) return page(source, [item("first")], "media-page");
        assert.equal(request.cursor, "media-page");
        return { ...page(source, [item("media")]), complete: !fail,
          gaps: fail ? [{ code: "missing", item_id: "media", message: "A referenced media asset is unavailable" }] : [] };
      };
      assert.equal((await app.run(producer)).phase, "partial");
      source = changed ? { ...source, title: "Renamed saved work", version: "native-v2", updated_at: 3 } : { ...source, version_reliable: false };
      fail = false; reads.length = 0;
      const recovered = await app.run(producer); assert.equal(recovered.phase, "complete"); assert.equal(recovered.items_added, 0);
      assert.deepEqual(reads, [null, "media-page"]);
      assert.equal((await app.histories.get(source.id))?.thread.title, source.title);
      assert.equal((await originals(app, source.id)).entries.length, 2);
    } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
  });
});
async function stoppedDuringIndexing(directory: string, producer: Producer) {
  const previous = await open(directory);
  let release = () => {}, entered = () => {}, indexes = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const pending = previous.importer.run([coordinator], [coordinator.host_id], [], native(producer), () => {}, async () => {
    if (++indexes === 1) return;
    entered(); await gate; throw new Error("Previous indexing owner stopped");
  });
  void pending.catch(() => {});
  await began;
  const progress = await previous.importer.status(); assert.equal(progress.phase, "indexing");
  assert.equal(previous.faux.state.callCount, 0);
  const legacy = defineDoc<{ progress: ImportProgress | null; indexing?: ImportProgress | null }>({
    kind: "agent.import-progress", scope: "session", version: 1, initial: () => ({ progress: null }), checkpointWhen: () => true,
  });
  await previous.session.commit(async (tx) => { delete (await tx.doc(legacy)).indexing; }, BACKGROUND_CONTEXT);
  await previous.session.close(BACKGROUND_CONTEXT);
  return { app: await open(directory), progress, settle: async () => { release(); await pending.catch(() => {}); } };
}

test("source text and cursors commit while native embedding is held, and joined imports finish with current published watermarks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-prewalk-search-")); const app = await open(directory);
  const tasks = new TaskStore(app.session, new ConversationModels(app.models)); tasks.useHistory(app.histories);
  const retrieval = new Retrieval(app.session, app.histories, tasks, join(directory, "search.sqlite"));
  let release = () => {}, entered = () => {}, releaseSource = () => {}, sourceEntered = () => {}, sourceFinished = () => {}, checkpointed = () => {};
  let indexes = 0, inventories = 0, hold = false, sourceStartedBeforeEmbedding = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
  const atTail = new Promise<void>((resolve) => { sourceEntered = resolve; });
  const walked = new Promise<void>((resolve) => { sourceFinished = resolve; });
  const postwalk = new Promise<void>((resolve) => { checkpointed = resolve; });
  const source = thread("retained-before-walk");
  const updates: ImportProgress[] = [];
  const embedding: HostCall = async (command) => {
    if (command.type !== "embed") throw new Error("Index catchup must not start workers or model turns");
    if (hold && command.purpose === "document") { hold = false; sourceStartedBeforeEmbedding = inventories > 0; entered(); await gate; }
    return { type: "embeddings", batch: { space: { id: "synthetic-import-search", model_revision: "fixture", model_digest: "fixture",
      dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 }, vectors: command.texts.map(() => [1, 0, 0]) } };
  };
  let pending: Promise<ImportProgress> | undefined, joined: Promise<ImportProgress> | undefined;
  try {
    const retained = item("retained-zirconia"); retained.text = "Zirconia connector dimensions";
    retained.data = { type: "userMessage", text: retained.text };
    const saved = await app.histories.import({ host_id: coordinator.host_id, thread: source, items: [retained],
      next_cursor: "remaining-text", complete: false, gaps: [] });
    await retrieval.sync(embedding, true);
    await app.histories.import({ host_id: coordinator.host_id, thread: source, items: [item("unpublished-resin")],
      next_cursor: "remaining-text", complete: false, gaps: [] });
    hold = true;
    const producer = native(async (_host, request) => {
      if (request.type === "list") {
        inventories += 1; if (request.archived) sourceFinished();
        return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      }
      if (request.type !== "read") throw new Error("No media is present");
      const current = updates.at(-1); assert.ok(current);
      if (request.cursor === "remaining-text") assert.deepEqual([current.phase, current.threads_seen, current.items_added], ["importing", 1, 0],
        "The first thread must report source work before its potentially large first page is read");
      if (request.cursor === "last-text") { sourceEntered(); await sourceGate; return page(source, [item("new-quartz")]); }
      assert.equal(request.cursor, "remaining-text");
      const added = item("new-sapphire"); added.text = "Sapphire connector verification";
      added.data = { type: "userMessage", text: added.text };
      return page(source, [added], "last-text");
    });
    const index = async () => { indexes += 1; await retrieval.sync(embedding, true); };
    pending = app.importer.run([coordinator], [coordinator.host_id], [], producer, (progress) => { updates.push(progress); if (progress.phase === "indexing") checkpointed(); }, index);
    await began;
    assert.equal(sourceStartedBeforeEmbedding, true, "Source discovery must start without waiting for the existing corpus embeddings");
    await atTail;
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.next_cursor, "last-text");
    assert.ok((await originals(app, source.id)).entries.some((entry) => entry.data.item.id === "new-sapphire"));
    assert.equal((await retrieval.snapshot("zirconia", [], 8)).candidates[0]?.conversation_id, saved.conversation.conversation_id);
    assert.equal(app.importer.isRunning(), true);
    joined = app.importer.run([coordinator], [coordinator.host_id], [], producer, () => {}, index);
    releaseSource(); await walked; await postwalk;
    assert.equal(indexes, 1); assert.equal(inventories, 2, "A joined import cannot start another native walk");
    assert.equal((await app.importer.status()).phase, "indexing", "Only the completed source walk can create a postwalk checkpoint");
    release();
    const result = await pending; assert.equal(result.phase, "complete"); assert.deepEqual(await joined, result); assert.equal(indexes, 2);
    assert.equal((await retrieval.snapshot("sapphire", [], 8)).candidates[0]?.conversation_id, saved.conversation.conversation_id);
    assert.equal((await retrieval.snapshot("quartz", [], 8)).candidates[0]?.conversation_id, saved.conversation.conversation_id);
    const retainedConversation = await app.histories.conversation(saved.conversation.conversation_id); assert.ok(retainedConversation);
    const tail = (await retainedConversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]; assert.ok(tail);
    const published = new SearchIndex(join(directory, "search.sqlite"));
    try { assert.deepEqual(published.checkpoint(saved.conversation.conversation_id), { watermark: tail.id.toString(), dirty: false }); }
    finally { published.close(); }
    assert.equal((await originals(app, source.id)).entries.length, 4); assert.equal(app.faux.state.callCount, 0);
  } finally {
    release(); releaseSource(); await Promise.allSettled([pending, joined]); retrieval.close();
    await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
});

test("failure drains the owned initial host call before request cleanup and restart resumes the committed source cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-prewalk-resume-")); const previous = await open(directory);
  let app = previous, closed = false, release = () => {}, entered = () => {}, releaseSource = () => {}, sourceEntered = () => {}, failedSourceFinished = () => {};
  let ownerFinished = false, callsAfterFinish = 0, sourceCalls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
  const atTail = new Promise<void>((resolve) => { sourceEntered = resolve; });
  const sourceFailed = new Promise<void>((resolve) => { failedSourceFinished = resolve; });
  const source = thread("unread-source"); let pending: Promise<ImportProgress> | undefined;
  const effects = new Set<Promise<void>>(), owners: number[] = [];
  const sourceCall = native(async (_host, request) => {
    if (request.type === "list") {
      if (request.archived && closed) failedSourceFinished();
      return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
    }
    if (request.type !== "read") throw new Error("No media in this fixture");
    if (request.cursor === "unread-page") return page(source, [item("committed-during-index")], "tail-page");
    assert.equal(request.cursor, "tail-page"); sourceEntered(); await sourceGate; return page(source, [item("uncommitted-tail")]);
  });
  const requests = new HostRequests((owner, callId, command) => {
    owners.push(owner); if (ownerFinished) callsAfterFinish += 1;
    if (command.type === "on_node" && command.command.type === "history") sourceCalls += 1;
    const operation = (async () => {
      let result: HostResult;
      try {
        if (command.type === "embed") { entered(); await gate; result = { type: "failed", message: "Previous index owner stopped" }; }
        else result = await sourceCall(command);
      } catch { result = { type: "failed", message: "Synthetic source operation failed" }; }
      requests.reply(owner, callId, result);
    })();
    effects.add(operation); void operation.finally(() => effects.delete(operation));
  });
  try {
    await previous.histories.import({ host_id: coordinator.host_id, thread: source, items: [item("before-stop")],
      next_cursor: "unread-page", gaps: [], complete: false });
    pending = previous.importer.run([coordinator], [coordinator.host_id], [], (command) => requests.call(71, command), () => {}, async () => {
      const result = await requests.call(71, { type: "embed", texts: ["Retained corpus"], purpose: "document" });
      if (result.type === "failed") throw new Error(result.message);
    }).finally(() => { requests.finish(71); ownerFinished = true; });
    void pending.catch(() => {});
    await began;
    assert.ok(sourceCalls > 0, "The owned initial index call must not gate source discovery");
    await atTail;
    assert.equal((await previous.histories.checkpoint(source.id, coordinator.host_id))?.next_cursor, "tail-page");
    assert.notEqual((await previous.importer.status()).phase, "indexing", "Only postwalk indexing can skip source discovery on resume");
    await previous.session.close(BACKGROUND_CONTEXT); closed = true; releaseSource();
    await sourceFailed; await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ownerFinished, false, "Request cleanup must retain its host-call owner until the initial index drains");
    release(); await assert.rejects(pending); assert.equal(ownerFinished, true); assert.equal(callsAfterFinish, 0); assert.ok(owners.every((id) => id === 71));
    app = await open(directory);
    assert.equal((await app.importer.status()).phase, "partial");
    let reads = 0;
    const resumed = await app.run((_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      if (request.type !== "read") throw new Error("No media is present");
      reads += 1; assert.equal(request.cursor, "tail-page"); return page(source, [item("after-stop")]);
    });
    assert.equal(resumed.phase, "complete"); assert.equal(reads, 1); assert.equal(app.indexCount(), 2);
    assert.deepEqual((await originals(app, source.id)).entries.map((entry) => entry.data.item.id), ["before-stop", "committed-during-index", "after-stop"]);
    assert.equal(app.faux.state.callCount, 0);
  } finally {
    if (!closed) await previous.session.close(BACKGROUND_CONTEXT);
    release(); releaseSource(); await pending?.catch(() => {}); requests.finish(71); await Promise.allSettled(effects);
    if (app !== previous) await app.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("prewalk indexing failure stays visible during source reads and final success clears only that failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-prewalk-failure-")); const app = await open(directory);
  const source = thread("missing-media"); let indexes = 0, reads = 0; const updates: ImportProgress[] = [];
  try {
    const result = await app.importer.run([coordinator], [coordinator.host_id], [], native(async (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      if (request.type !== "read") throw new Error("No transferable media is present");
      reads += 1;
      return { ...page(source, [item("retained-with-missing-media")]), complete: false,
        gaps: [{ code: "missing", item_id: "retained-with-missing-media", message: "A referenced media asset is unavailable" }] };
    }), (progress) => updates.push(progress), async () => { if (++indexes === 1) throw new Error("Synthetic initial index failure"); });
    assert.ok(updates.some((progress) => progress.phase === "importing" && progress.gaps.includes("Initial search indexing: Synthetic initial index failure")));
    assert.equal(indexes, 2); assert.equal(reads, 1); assert.equal(result.phase, "partial"); assert.equal(result.gap_count, 1);
    assert.deepEqual(result.gaps, ["missing-media: A referenced media asset is unavailable"]);
    assert.equal((await originals(app, source.id)).entries.length, 1); assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

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
    assert.equal(app.indexCount(), 4);
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
    assert.equal(results[0]?.phase, "complete"); assert.equal(inventories, 2); assert.equal(reads, 1); assert.equal(app.indexCount(), 2);
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

test("interrupted indexing resumes retained counts and gaps without rereading sources regardless of host availability", async (t) => {
  for (const available of [
    { name: "online", nodes: [coordinator], online: [coordinator.host_id] },
    { name: "unregistered", nodes: [], online: [] },
    { name: "offline", nodes: [coordinator], online: [] },
  ]) await t.test(available.name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-importer-index-resume-"));
    const source = thread("retained-media"), failed = thread("failed-read"), tail = thread("new-tail"); let catchup = false;
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source, failed, ...(catchup ? [tail] : [])], next_cursor: null };
      if (request.type !== "read") throw new Error("No transferable assets are present");
      if (request.thread_id === failed.id && !catchup) throw new Error("Synthetic native read unavailable");
      if (request.thread_id === source.id) return { ...page(source, [item("retained")]), complete: false,
        gaps: [{ code: "missing", item_id: "retained", message: "A referenced media asset is unavailable" }] };
      return page(request.thread_id === failed.id ? failed : tail, [item(request.thread_id)]);
    };
    const stopped = await stoppedDuringIndexing(directory, producer); const { app, progress } = stopped;
    let release = () => {}, entered = () => {}, sourceCalls = 0, indexCalls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { entered = resolve; });
    const forbidden: HostCall = async () => { sourceCalls += 1; throw new Error("Resuming indexing must not read native sources"); };
    const index = async () => { indexCalls += 1; entered(); await gate; };
    try {
      const status = await app.importer.status(); assert.equal(status.phase, "partial");
      assert.equal(status.gap_count, progress.gap_count + 1);
      const first = app.importer.run(available.nodes, available.online, [], forbidden, () => {}, index);
      const second = app.importer.run(available.nodes, available.online, [], forbidden, () => {}, index);
      void first.catch(() => {}); void second.catch(() => {});
      try {
        await Promise.race([began, first.then(() => { throw new Error("Index recovery did not reach its callback"); })]);
        assert.equal(sourceCalls, 0, "The resumed phase must not walk native inventory again"); assert.equal(indexCalls, 1);
        assert.deepEqual(await app.importer.status(), progress);
        release();
        const results = await Promise.all([first, second]);
        assert.deepEqual(results, [{ ...progress, phase: "partial" }, { ...progress, phase: "partial" }]);
      } finally { release(); await Promise.allSettled([first, second]); }
      assert.equal(app.importer.isRunning(), false); assert.equal(app.faux.state.callCount, 0);
      assert.deepEqual((await originals(app, source.id)).entries.map((entry) => entry.data.item.id), ["retained"]);
      catchup = true;
      const fresh = await app.run(producer);
      assert.equal(fresh.threads_seen, 3); assert.equal(fresh.items_added, 2); assert.equal(fresh.items_unchanged, 1);
      assert.equal(fresh.gap_count, 1); assert.equal((await originals(app, tail.id)).entries.length, 1);
    } finally { release(); await stopped.settle(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
  });
});

test("explicit host selection starts a new native walk instead of claiming an interrupted index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-index-selection-")); const source = thread("retained");
  const producer: Producer = (_host, request) => {
    if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
    if (request.type !== "read") throw new Error("No assets are present");
    return page(source, [item("retained")]);
  };
  const stopped = await stoppedDuringIndexing(directory, producer); const { app } = stopped;
  const hosts: string[] = []; let indexes = 0;
  const call = native((host, request) => { hosts.push(host); return producer(host, request); });
  try {
    await assert.rejects(app.importer.run([coordinator, laptop], [coordinator.host_id, laptop.host_id], ["unknown"], call, () => {}, async () => { indexes += 1; }), /registered history host/);
    assert.equal(indexes, 0); assert.deepEqual(hosts, []);
    const result = await app.importer.run([coordinator, laptop], [coordinator.host_id, laptop.host_id], [laptop.name], call, () => {}, async () => { indexes += 1; });
    assert.equal(result.phase, "complete"); assert.equal(result.items_added, 0); assert.equal(result.items_unchanged, 1);
    assert.deepEqual(hosts, [laptop.host_id, laptop.host_id, laptop.host_id]); assert.equal(indexes, 2);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await stopped.settle(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a failed index keeps source progress across reopen and clears resolved index errors on recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-index-failure-")); let app = await open(directory);
  const source = thread("retained-source");
  const producer: Producer = (_host, request) => {
    if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
    if (request.type !== "read") throw new Error("No transferable assets are present");
    return { ...page(source, [item("retained")]), complete: false, gaps: [
      { code: "missing", item_id: "retained", message: "A referenced media asset is unavailable" },
      { code: "unavailable", item_id: null, message: "Synthetic native evidence is temporarily unavailable" },
    ] };
  };
  let sourceCalls = 0, indexes = 0;
  const forbidden: HostCall = async () => { sourceCalls += 1; throw new Error("Index recovery must not call a source host"); };
  try {
    const failed = await app.importer.run([coordinator], [coordinator.host_id], [], native(producer), () => {}, async () => {
      indexes += 1; throw new Error("The execution request ended before the host operation completed");
    });
    assert.equal(failed.phase, "partial"); assert.equal(failed.items_added, 1); assert.equal(failed.gap_count, 3);
    assert.equal(failed.gaps[0], "Search indexing: The execution request ended before the host operation completed");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.deepEqual(await app.importer.status(), failed);
    const repeated = await app.importer.run([coordinator], [coordinator.host_id], [], forbidden, () => {}, async () => {
      indexes += 1; throw new Error("Synthetic second index failure");
    });
    assert.equal(sourceCalls, 0, "Public partial status must not discard the pending index checkpoint");
    assert.equal(repeated.gap_count, 3); assert.equal(repeated.gaps[0], "Search indexing: Synthetic second index failure");
    assert.deepEqual(repeated.gaps.slice(1), failed.gaps.slice(1));
    const recovered = await app.importer.run([], [], [], forbidden, () => {}, async () => { indexes += 1; });
    assert.deepEqual(recovered, { ...failed, gap_count: 2, gaps: failed.gaps.slice(1) });
    assert.equal(sourceCalls, 0); assert.equal(indexes, 4);
    assert.deepEqual((await originals(app, source.id)).entries.map((entry) => entry.data.item.id), ["retained"]);
    const fresh = await app.run(producer);
    assert.equal(fresh.items_added, 0); assert.equal(fresh.items_unchanged, 1); assert.equal(app.indexCount(), 2);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("deleted advertised media preserves mixed user text and same-version recovery attaches the verified file without another message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-deleted-media-")); let app = await open(directory);
  try {
    const source = thread("mixed-media"), evidence = item("mixed-input");
    const path = join(directory, "source-image"), bytes = Buffer.from("synthetic image");
    const digest = createHash("sha256").update(bytes).digest("hex"); await writeFile(path, bytes);
    const text = "The connector needs insulation before this image can be used.";
    evidence.text = text; evidence.data = { type: "userMessage", content: [{ type: "text", text }, { type: "image", path }] };
    evidence.assets = [{ path, item_id: evidence.id, version: evidence.version, kind: "local_media", media_type: "image/png", sha256: digest, size: bytes.length }];
    let deleted = true;
    const producer: Producer = async (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [] : [source], next_cursor: null };
      if (request.type === "read") return page(source, [evidence]);
      if (deleted) await rm(path, { force: true }); // Disappears after the native item advertised it.
      const content = await readFile(path);
      return { type: "asset", path, offset: request.offset, data_base64: content.toString("base64"), next_offset: null, total_bytes: content.length, sha256: digest };
    };
    const failed = await app.run(producer);
    assert.equal(failed.phase, "partial"); assert.equal(failed.items_added, 1); assert.ok(failed.gap_count > 0);
    const partial = await originals(app, source.id); const entry = partial.entries[0]; assert.ok(entry);
    assert.equal(partial.entries.length, 1); assert.equal(entry.data.item.text, text); assert.deepEqual(entry.data.item.assets, []);
    assert.deepEqual(await app.histories.original(entry), evidence.data); assert.ok((await app.histories.indexText(entry))?.includes(text));
    const conversationId = partial.conversation.id.toString();
    let beforeWatermark: string | undefined;
    for await (const record of app.histories.inventory()) if (record.conversation_id === conversationId) beforeWatermark = record.watermark;
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    deleted = false; await writeFile(path, bytes);
    const recovered = await app.run(producer, [laptop]);
    assert.equal(recovered.phase, "complete"); assert.equal(recovered.items_added, 0); assert.equal(recovered.items_unchanged, 1);
    const saved = await originals(app, source.id); assert.equal(saved.entries.length, 1); assert.deepEqual(saved.entries[0], entry);
    const projected = saved.entries.flatMap(transcript); assert.deepEqual(projected.map((message) => message.text), [text]);
    const updated = await app.histories.entry(conversationId, entry.id.toString()); assert.ok(ImportedItemEntry.is(updated));
    assert.equal(updated.data.item.version, evidence.version); assert.equal(updated.data.item.assets[0]?.path, join(app.assets, digest));
    assert.deepEqual(await readFile(join(app.assets, digest)), bytes); assert.deepEqual(await app.histories.original(updated), evidence.data);
    let afterWatermark: string | undefined;
    for await (const record of app.histories.inventory()) if (record.conversation_id === conversationId) afterWatermark = record.watermark;
    assert.ok(beforeWatermark && afterWatermark); assert.notEqual(afterWatermark, beforeWatermark, "Recovered assets must invalidate the existing search watermark");
    assert.equal((await app.histories.checkpoint(source.id, laptop.host_id))?.complete, true);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
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
    assert.equal(failed.phase, "partial"); assert.equal(failed.items_added, 1); assert.ok(failed.gap_count > 0);
    const initial = (await originals(app, source.id)).entries[0]; assert.ok(initial);
    assert.equal(initial.data.item.text, evidence.text); assert.deepEqual(initial.data.item.assets, []);
    await assert.rejects(app.histories.original(initial), /Full historical original is unavailable/);
    assert.ok((await app.histories.indexText(initial))?.startsWith("Bounded historical excerpt (full original unavailable):\n"));
    assert.deepEqual(await readdir(app.assets), []);
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.complete, false);
    fail = false; const recovered = await app.run(producer);
    assert.equal(recovered.phase, "complete"); assert.equal(recovered.items_added, 0); assert.equal(recovered.items_unchanged, 1); assert.equal(recovered.assets_saved, 1);
    const saved = await originals(app, source.id); assert.equal(saved.entries.length, 1);
    const entry = saved.entries[0]; assert.ok(entry);
    assert.deepEqual(entry, initial, "Recovered assets must not rewrite the immutable item");
    const updated = await app.histories.entry(saved.conversation.id.toString(), entry.id.toString()); assert.ok(ImportedItemEntry.is(updated));
    const asset = updated.data.item.assets[0]; assert.ok(asset); assert.equal(asset.path, join(app.assets, digest));
    assert.deepEqual(await readFile(asset.path), bytes); assert.equal((await stat(asset.path)).mode & 0o777, 0o600);
    assert.deepEqual(await app.histories.original(entry), original);
    const before = assetReads; const repeated = await app.run(producer);
    assert.equal(repeated.threads_unchanged, 1); assert.equal(assetReads, before);
    assert.equal((await originals(app, source.id)).entries.length, 1); assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("operational asset transfer failures outrank missing media and recover without losing retained evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-importer-transfer-")); let app = await open(directory);
  try {
    const before = thread("expired-before"), source = thread("transfer"), after = thread("expired-after", true);
    const retained = item("retained"), evidence = item("asset-evidence"), original = evidence.data;
    const bytes = Buffer.from(JSON.stringify(original)), digest = createHash("sha256").update(bytes).digest("hex");
    const locator = "/native/source/evidence.json";
    evidence.data = null;
    evidence.assets = [{ path: locator, item_id: evidence.id, version: evidence.version, kind: "cold_evidence", media_type: "application/json", sha256: digest, size: bytes.length }];
    const failure = "The execution client did not confirm the operation; inspect its state before retrying";
    let fail = true, assetReads = 0;
    const producer: Producer = (_host, request) => {
      if (request.type === "list") return { type: "list", threads: request.archived ? [after] : [before, source], next_cursor: null };
      if (request.type === "read") {
        if (request.thread_id === source.id) return page(source, [retained, evidence]);
        const expired = request.thread_id === before.id ? before : after;
        const entries = Array.from({ length: expired.archived ? 3 : 55 }, (_, index) => item(`${expired.id}-${index}`));
        return { ...page(expired, entries), complete: false,
          gaps: entries.map((entry) => ({ code: "missing", item_id: entry.id, message: "A referenced media asset is unavailable" })) };
      }
      assert.equal(request.thread_id, source.id); assert.equal(request.path, locator); assetReads += 1;
      if (fail && request.offset > 0) throw new Error(failure);
      const end = Math.min(bytes.length, request.offset + 17);
      return { type: "asset", path: locator, offset: request.offset, data_base64: bytes.subarray(request.offset, end).toString("base64"),
        next_offset: end === bytes.length ? null : end, total_bytes: bytes.length, sha256: digest };
    };
    const failed = await app.run(producer);
    assert.equal(failed.phase, "partial"); assert.equal(failed.gap_count, 59); assert.equal(failed.gaps.length, 50);
    assert.equal(failed.gaps[0], `${source.id}: ${failure}`, "Operational failure must survive a full missing-media summary and later missing gaps");
    const checkpoint = await app.histories.checkpoint(source.id, coordinator.host_id); assert.ok(checkpoint);
    assert.equal(checkpoint.complete, false); assert.equal(checkpoint.next_cursor, null);
    assert.deepEqual(checkpoint.gaps, [{ code: "unavailable", item_id: evidence.id, message: failure }]);
    assert.ok((await app.histories.checkpoint(before.id, coordinator.host_id))?.gaps.every((gap) => gap.code === "missing"));
    assert.deepEqual((await originals(app, source.id)).entries.map((entry) => entry.data.item.id), [retained.id, evidence.id]);
    assert.deepEqual(await readdir(app.assets), []);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory); fail = false;
    const recovered = await app.run(producer);
    assert.equal(recovered.phase, "partial", "Native missing references remain coverage gaps");
    assert.equal(recovered.gap_count, 58); assert.equal(recovered.items_added, 0); assert.equal(recovered.items_unchanged, 59,
      "The intact sibling of the failed asset item does not need another read/import");
    assert.equal((await app.histories.checkpoint(source.id, coordinator.host_id))?.complete, true);
    assert.deepEqual((await app.histories.checkpoint(source.id, coordinator.host_id))?.gaps, []);
    const entries = (await originals(app, source.id)).entries;
    assert.deepEqual(entries.map((entry) => entry.data.item.id), [retained.id, evidence.id]);
    const saved = entries.find((entry) => entry.data.item.id === evidence.id); assert.ok(saved);
    assert.deepEqual(await app.histories.original(saved), original);
    const reads = assetReads, repeated = await app.run(producer);
    assert.equal(repeated.items_added, 0); assert.equal(repeated.threads_unchanged, 1); assert.equal(assetReads, reads);
    assert.equal((await originals(app, source.id)).entries.length, 2); assert.equal(app.faux.state.callCount, 0);
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
