import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel } from "node:worker_threads";
import { test } from "node:test";
import { SearchIndex, type Embed, type SearchRecord, type SearchWatermark } from "../src/search.js";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";

const space: EmbeddingSpace = { id: "synthetic-space-v1", model_revision: "synthetic", model_digest: "synthetic",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 };
const record = (entry_id: string, text: string, ordinal = 0, source_refs: string[] = []): SearchRecord => ({ entry_id, text, ordinal, source_refs });
async function* records(values: SearchRecord[]): AsyncIterable<SearchRecord> { yield* values; }
async function* inventory(values: SearchWatermark[]): AsyncIterable<SearchWatermark> { yield* values; }
function vector(text: string): number[] {
  if (/automobile|transport maintenance|tire/iu.test(text)) return [1, 0, 0];
  if (/bicycle/iu.test(text)) return [0.9, Math.sqrt(0.19), 0];
  return [0, 0, 1];
}
const embed: Embed = async (texts) => ({ space, vectors: texts.map(vector) });

test("cached corpus indexing serves queued I/O against the prior publication before replacing it", async () => {
  const index = new SearchIndex(":memory:"), channel = new MessageChannel();
  try {
    const data = Array.from({ length: 512 }, (_, ordinal) => record(`e${ordinal}`, `Automobile maintenance record ${ordinal}`, ordinal));
    await index.upsert("service", "one", records(data), embed);
    let served = false;
    const response = new Promise<void>((resolve, reject) => {
      channel.port1.once("message", () => {
        served = true;
        try {
          assert.deepEqual(index.checkpoint("service"), { watermark: "one", dirty: true });
          void index.search("Automobile", undefined, [], 1, "keyword").then((result) => {
            assert.equal(result.candidates[0]?.conversation_id, "service"); resolve();
          }).catch(reject);
        } catch (error) { reject(error); }
      });
    });
    channel.port2.postMessage("queued foreground read");
    await index.upsert("service", "two", records(data), async () => { throw new Error("Cached text must not invoke embedding again"); });
    assert.equal(served, true, "Cached indexing must yield to ready I/O before finishing the corpus");
    await response;
    assert.deepEqual(index.checkpoint("service"), { watermark: "two", dirty: false });
  } finally { channel.port1.close(); channel.port2.close(); await index.close(); }
});

test("native dense retrieval finds vocabulary mismatches independently and groups several conversations", async () => {
  const index = new SearchIndex(":memory:");
  try {
    await index.upsert("automobile", "a1", records([record("a1", "The automobile needs a new tire", 0, ["mail:example:thread-a"])]), embed);
    await index.upsert("bicycle", "b1", records([record("b1", "A bicycle repair quote", 0, ["mail:example:thread-b"])]), embed);
    await index.upsert("cake", "c1", records([record("c1", "Bake a chocolate cake", 0, ["mail:example:thread-c"])]), embed);
    const result = await index.search("transport maintenance", embed, [], 3);
    assert.deepEqual(result.gaps, []);
    assert.deepEqual(result.candidates.slice(0, 2).map((item) => item.conversation_id), ["automobile", "bicycle"]);
    assert.equal(result.candidates[0]?.matches[0]?.entry_id, "a1");
    assert.deepEqual(result.candidates[0]?.matches[0]?.source_refs, ["mail:example:thread-a"]);
    const exact = await index.search("transport maintenance", embed, ["mail:example:thread-c"], 3);
    assert.equal(exact.candidates[0]?.conversation_id, "cake");
    await index.delete("automobile");
    assert.equal((await index.search("transport maintenance", embed, [], 3)).candidates.some((item) => item.conversation_id === "automobile"), false);
  } finally { await index.close(); }
});

test("an exact source conversation precedes an unrelated lexical and dense agreement", async () => {
  const index = new SearchIndex(":memory:");
  try {
    await index.upsert("exact-history", "one", records([record("cake", "Cake recipe", 0, ["mail:synthetic:exact"])]), embed);
    await index.upsert("distractor", "two", records([record("car", "Automobile maintenance")]), embed);
    const result = await index.search("automobile", embed, ["mail:synthetic:exact"], 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.conversation_id), ["exact-history", "distractor"]);
    assert.ok(result.candidates[0]!.score > result.candidates[1]!.score);
    assert.deepEqual(result.candidates[0]?.matches[0]?.source_refs, ["mail:synthetic:exact"]);
  } finally { await index.close(); }
});

test("published text vectors are reused across conversations without merging ownership or surviving every owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-published-vector-reuse-")); const path = join(directory, "search.sqlite");
  let index = new SearchIndex(path); let documents = 0;
  const embedding: Embed = async (texts, purpose) => { if (purpose === "document") documents += texts.length; return embed(texts, purpose); };
  const text = "Identical automobile maintenance evidence";
  try {
    await index.upsert("first", "one", records([record("first-entry", text, 0, ["mail:synthetic:first"])]), embedding);
    await index.close(); index = new SearchIndex(path);
    await index.upsert("second", "one", records([record("second-entry", text, 0, ["mail:synthetic:second"])]), embedding);
    assert.equal(documents, 1, "Identical published text must not invoke document embedding again for another conversation");
    const found = await index.search("automobile", embedding);
    assert.deepEqual(found.candidates.map((candidate) => [candidate.conversation_id, candidate.matches.map((match) => [match.entry_id, match.source_refs])]), [
      ["first", [["first-entry", ["mail:synthetic:first"]]]], ["second", [["second-entry", ["mail:synthetic:second"]]]],
    ]);
    await index.delete("first");
    const remaining = await index.search("automobile", embedding);
    assert.deepEqual(remaining.candidates.map((candidate) => candidate.conversation_id), ["second"]);
    assert.equal(remaining.candidates[0]?.matches[0]?.entry_id, "second-entry");
    await index.upsert("third", "one", records([record("third-entry", text)]), embedding);
    assert.equal(documents, 1, "Any remaining published owner can supply the cached vector");
    await index.delete("second"); await index.delete("third");
    await index.upsert("fourth", "one", records([record("fourth-entry", text)]), embedding);
    assert.equal(documents, 2, "Removing every published owner must remove the reusable vector too");
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("streamed indexing reuses vectors and preserves the old checkpoint on interruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-")); const path = join(directory, "search.sqlite");
  const batches: number[] = []; let fail = false;
  const embedding: Embed = async (texts, purpose) => { if (fail) throw new Error("Runner unavailable"); if (purpose === "document") batches.push(texts.length); return embed(texts, purpose); };
  let index = new SearchIndex(path);
  try {
    const data = Array.from({ length: 37 }, (_, ordinal) => record(`e${ordinal}`, `Automobile service record ${ordinal}`, ordinal));
    await index.upsert("service", "37", records(data), embedding);
    assert.deepEqual(batches, [16, 16, 5]);
    batches.length = 0;
    await index.upsert("service", "metadata-only-38", records(data), embedding);
    assert.deepEqual(batches, [], "The same content at a newer native watermark must not be re-embedded");
    async function* interrupted() { yield* data; yield record("new", "New material", 38); throw new Error("Source read interrupted"); }
    await assert.rejects(index.upsert("service", "39", interrupted(), embedding), /Source read interrupted/);
    assert.deepEqual(index.checkpoint("service"), { watermark: "metadata-only-38", dirty: true });
    assert.ok((await index.search("Automobile", embedding)).candidates[0]?.matches.some((item) => item.entry_id !== "new"));
    await index.close(); index = new SearchIndex(path);
    await index.reconcile(inventory([{ conversation_id: "service", watermark: "40" }]), () => records([...data, record("new", "The bicycle is fixed", 38)]), embedding);
    assert.deepEqual(index.checkpoint("service"), { watermark: "40", dirty: false });
    assert.equal(batches.at(-1), 1);
    fail = true;
    const lexical = await index.search("Automobile", embedding);
    assert.ok(lexical.candidates.length > 0); assert.deepEqual(lexical.gaps, ["Runner unavailable"]);
    await index.reconcile(inventory([]), () => records([]), embedding);
    assert.equal(index.checkpoint("service"), undefined);
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("completed partial embedding batches survive reopen without publishing stale source rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-resume-")); const path = join(directory, "search.sqlite");
  let index = new SearchIndex(path); let batch = 0; let fail = false; const documents: string[] = [];
  const embedding: Embed = async (texts, purpose) => {
    if (purpose === "document") {
      batch += 1; if (fail && batch === 3) throw new Error("Synthetic runner stopped");
      documents.push(...texts);
    }
    return embed(texts, purpose);
  };
  try {
    await index.upsert("large", "old", records([record("old", "Original published evidence")]), embedding);
    const source = Array.from({ length: 48 }, (_, ordinal) => record(`e${ordinal}`, `Automobile evidence ${ordinal}`, ordinal, [`mail:synthetic:${ordinal}`]));
    fail = true; batch = 0; documents.length = 0;
    await assert.rejects(index.upsert("large", "unfinished", records(source), embedding), /Synthetic runner stopped/);
    assert.equal(documents.length, 32);
    assert.deepEqual(index.checkpoint("large"), { watermark: "old", dirty: true });
    assert.deepEqual((await index.search("published", embed)).candidates[0]?.matches.map((match) => match.entry_id), ["old"]);
    await index.close(); index = new SearchIndex(path); fail = false; documents.length = 0;
    const current = source.filter((row) => row.entry_id !== "e3").map((row) => row.entry_id === "e5"
      ? record(row.entry_id, "Changed cobalt evidence", row.ordinal, ["mail:synthetic:changed"])
      : row.entry_id === "e6" ? record("renamed-six", row.text, row.ordinal, ["mail:synthetic:current-six"]) : row);
    await index.upsert("large", "current", records(current), embedding);
    assert.deepEqual(documents.sort(), ["Changed cobalt evidence", ...source.slice(32).map((row) => row.text)].sort(),
      "Completed vectors must survive failure and restart; only changed or unfinished text needs embedding");
    assert.deepEqual(index.checkpoint("large"), { watermark: "current", dirty: false });
    const db = new DatabaseSync(path);
    try {
      assert.deepEqual(db.prepare("SELECT entry_id,text,source_refs FROM chunks WHERE conversation_id=? ORDER BY ordinal,part").all("large")
        .map((row) => [row.entry_id, row.text, row.source_refs]), current.map((row) => [row.entry_id, row.text, JSON.stringify(row.source_refs)]));
      assert.equal(db.prepare("SELECT count(*) AS count FROM staging").get()?.count, 0);
    } finally { db.close(); }
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("partial vector caches are conversation scoped and deleted or rebuilt with their owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-cache-owner-")); const path = join(directory, "search.sqlite");
  const index = new SearchIndex(path); let requested = 0; let current = space;
  const embedding: Embed = async (texts, purpose) => { if (purpose === "document") requested += texts.length; return { space: current, vectors: texts.map(vector) }; };
  const data = Array.from({ length: 16 }, (_, ordinal) => record(`e${ordinal}`, `Automobile cache evidence ${ordinal}`, ordinal));
  async function* interrupted() { yield* data; throw new Error("Synthetic source stopped"); }
  try {
    await assert.rejects(index.upsert("partial", "one", interrupted(), embedding), /Synthetic source stopped/);
    requested = 0; await index.upsert("other", "one", records(data), embedding); assert.equal(requested, 16);
    await index.delete("other"); await index.delete("partial"); requested = 0;
    await index.upsert("partial", "two", records(data), embedding); assert.equal(requested, 16, "Deleted ownership must remove unpublished cached vectors too");
    await assert.rejects(index.upsert("rebuilt", "one", interrupted(), embedding), /Synthetic source stopped/);
    requested = 0; current = { ...space, id: "rebuilt-space", instruction_version: 2 };
    await index.rebuild(inventory([{ conversation_id: "rebuilt", watermark: "two" }]), () => records(data), embedding);
    assert.equal(requested, 16, "An explicit rebuild cannot reuse vectors from the prior embedding space");
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM staging").get()?.count, 0);
      assert.equal(db.prepare("SELECT count(*) AS count FROM conversations").get()?.count, 1);
    } finally { db.close(); }
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy ephemeral staging migrates without changing the published projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-staging-migration-")); const path = join(directory, "search.sqlite");
  let index = new SearchIndex(path);
  try {
    await index.upsert("retained", "one", records([record("one", "Retained published evidence")]), embed); await index.close();
    const old = new DatabaseSync(path);
    old.exec(`DROP TABLE staging;
      CREATE TABLE staging(run TEXT NOT NULL, entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL, part INTEGER NOT NULL,
        hash TEXT NOT NULL, text TEXT NOT NULL, source_refs TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY(run,entry_id,part));`);
    old.prepare("INSERT INTO staging VALUES(?,?,?,?,?,?,?,?)").run("old-run", "not-published", 0, 0, "old-hash", "Unpublished legacy data", "[]", new Uint8Array(new Float32Array([1, 0, 0]).buffer)); old.close();
    index = new SearchIndex(path);
    assert.deepEqual(index.checkpoint("retained"), { watermark: "one", dirty: false });
    assert.deepEqual((await index.search("Retained", embed)).candidates[0]?.matches.map((match) => match.entry_id), ["one"]);
    await index.upsert("retained", "two", records([record("two", "Current published evidence")]), embed);
    assert.deepEqual((await index.search("Current", embed)).candidates[0]?.matches.map((match) => match.entry_id), ["two"]);
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a repeated source entry cannot overwrite another part of the same indexing attempt", async () => {
  const index = new SearchIndex(":memory:");
  try {
    await index.upsert("work", "old", records([record("old", "Original evidence")]), embed);
    await assert.rejects(index.upsert("work", "bad", records([record("duplicate", "First value"), record("duplicate", "Conflicting value")]), embed), /repeated an entry part/);
    assert.deepEqual(index.checkpoint("work"), { watermark: "old", dirty: true });
    assert.equal((await index.search("Original", embed)).candidates[0]?.matches[0]?.entry_id, "old");
    await index.upsert("work", "fixed", records([record("duplicate", "Corrected source")]), embed);
    assert.equal((await index.search("Corrected", embed)).candidates[0]?.matches[0]?.text, "Corrected source");
  } finally { await index.close(); }
});

test("the old text generation is refreshed even when native conversation watermarks stay the same", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-")); const path = join(directory, "search.sqlite");
  let index = new SearchIndex(path);
  try {
    await index.upsert("old-preview", "same-tail", records([record("title", "Legacy oversized preview")]), embed);
    await index.close();
    const legacy = new DatabaseSync(path);
    legacy.prepare("UPDATE metadata SET value=? WHERE key='chunker'").run("message-utf8-2048-overlap-256-v1"); legacy.close();
    index = new SearchIndex(path);
    assert.deepEqual(index.checkpoint("old-preview"), { watermark: "same-tail", dirty: true });
    await index.reconcile(inventory([{ conversation_id: "old-preview", watermark: "same-tail" }]),
      () => records([record("title", "Concise current title")]), embed);
    assert.deepEqual(index.checkpoint("old-preview"), { watermark: "same-tail", dirty: false });
    const result = await index.search("Concise", embed);
    assert.equal(result.candidates[0]?.matches[0]?.text, "Concise current title");
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a missed notification and a commit during embedding both remain reconcilable", async () => {
  let release = () => {}; let started = () => {}; let gate = false;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const embedding: Embed = async (texts, purpose) => {
    if (gate) { gate = false; started(); await wait; }
    return embed(texts, purpose);
  };
  const index = new SearchIndex(":memory:");
  try {
    await index.upsert("work", "one", records([record("one", "First note")]), embedding);
    gate = true;
    const indexing = index.upsert("work", "two", records([record("two", "Second note")]), embedding);
    await began; await index.markDirty("work"); release(); await indexing;
    assert.deepEqual(index.checkpoint("work"), { watermark: "two", dirty: true });
    await index.reconcile(inventory([{ conversation_id: "work", watermark: "three" }]), () => records([record("three", "Latest note")]), embedding);
    assert.deepEqual(index.checkpoint("work"), { watermark: "three", dirty: false });
    // No markDirty call: startup inventory must still detect the native tail change.
    await index.reconcile(inventory([{ conversation_id: "work", watermark: "four" }]), () => records([record("four", "A missed commit")]), embedding);
    assert.equal((await index.search("missed", embedding)).candidates[0]?.matches[0]?.entry_id, "four");
  } finally { release(); await index.close(); }
});

test("search does not mix old lexical ranks with rows published during the embedding await", async () => {
  const index = new SearchIndex(":memory:");
  let release = () => {}; let started = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  try {
    await index.upsert("old", "one", records([record("old-entry", "The needle document", 0, ["mail:example:old"])]), embed);
    const pending = index.search("needle", async (texts, purpose) => { started(); await wait; return embed(texts, purpose); }, ["mail:example:old"]);
    await began;
    await index.delete("old");
    await index.upsert("replacement", "two", records([record("replacement-entry", "A cake recipe")]), embed);
    release();
    assert.deepEqual(await pending, await index.search("needle", embed, ["mail:example:old"]));
  } finally { release(); await index.close(); }
});

test("space changes require an explicit rebuild while lexical evidence remains available", async () => {
  let current = space;
  const embedding: Embed = async (texts) => ({ space: current, vectors: texts.map(vector) });
  const index = new SearchIndex(":memory:");
  try {
    await index.upsert("first", "one", records([record("one", "Automobile paperwork")]), embedding);
    current = { ...space, id: "synthetic-space-v2", instruction_version: 2 };
    await assert.rejects(index.upsert("first", "two", records([record("two", "New automobile paperwork")]), embedding), /space changed/);
    const old = await index.search("paperwork", embedding);
    assert.equal(old.candidates[0]?.matches[0]?.entry_id, "one");
    assert.ok(old.gaps.some((gap) => gap.includes("space changed")));
    await index.rebuild(inventory([{ conversation_id: "first", watermark: "two" }]), () => records([record("two", "New automobile paperwork")]), embedding);
    assert.deepEqual(index.checkpoint("first"), { watermark: "two", dirty: false });
    assert.deepEqual((await index.search("paperwork", embedding)).gaps, []);
  } finally { await index.close(); }
});

test("bounded Unicode chunks retain entry provenance and representative queries use native search indexes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-plans-")); const path = join(directory, "search.sqlite");
  const index = new SearchIndex(path);
  try {
    const text = "Automobile 🚗 maintenance\n".repeat(300);
    await index.upsert("unicode", "one", records([record("unicode-entry", text, 0, ["mail:synthetic:thread"])]), embed);
    const result = await index.search("Automobile", embed);
    assert.ok(result.candidates[0]?.matches.length);
    for (const match of result.candidates[0]?.matches ?? []) {
      assert.equal(match.entry_id, "unicode-entry"); assert.equal(match.text.includes("�"), false);
      assert.ok(Buffer.byteLength(match.text) <= 2048); assert.deepEqual(match.source_refs, ["mail:synthetic:thread"]);
    }
    await index.upsert("representative", "1000", records(Array.from({ length: 1000 }, (_, ordinal) =>
      record(`entry-${ordinal}`, `Automobile maintenance sample ${ordinal}`, ordinal, [`mail:synthetic:${ordinal}`]))), embed);
    await index.upsert("published-clone", "1000", records(Array.from({ length: 1000 }, (_, ordinal) =>
      record(`clone-${ordinal}`, `Automobile maintenance sample ${ordinal}`, ordinal, [`mail:synthetic:clone-${ordinal}`]))), embed);
    const partial = Array.from({ length: 1024 }, (_, ordinal) => record(`partial-${ordinal}`, `Partial automobile evidence ${ordinal}`, ordinal));
    async function* interrupted() { yield* partial; throw new Error("Synthetic source stopped"); }
    for (const id of ["partial-plan", "other-partial-plan"]) await assert.rejects(index.upsert(id, "1024", interrupted(), embed), /Synthetic source stopped/);
    const db = new DatabaseSync(path, { allowExtension: true });
    try {
      assert.ok(process.env.AGENT_SQLITE_VEC); db.loadExtension(process.env.AGENT_SQLITE_VEC);
      const publishedHashes = db.prepare("SELECT hash FROM chunks WHERE conversation_id=? ORDER BY ordinal LIMIT 16").all("representative").map((row) => {
        assert.ok(typeof row.hash === "string"); return row.hash;
      });
      const publishedSlots = publishedHashes.map(() => "?").join(",");
      const oldPublishedCache = `SELECT c.hash,v.embedding FROM chunks c JOIN chunk_vectors v ON v.rowid=c.id WHERE c.conversation_id=? AND c.hash IN (${publishedSlots})`;
      const publishedCache = `SELECT c.hash,v.embedding FROM (SELECT hash,min(id) AS id FROM chunks WHERE hash IN (${publishedSlots}) GROUP BY hash) c JOIN chunk_vectors v ON v.rowid=c.id`;
      db.exec("DROP INDEX chunks_text_hash; CREATE INDEX chunks_hash ON chunks(conversation_id,hash)");
      const publishedBefore = db.prepare("EXPLAIN QUERY PLAN " + oldPublishedCache).all("representative", ...publishedHashes);
      assert.equal(db.prepare(oldPublishedCache).all("representative", ...publishedHashes).length, 16);
      const globalBefore = db.prepare("EXPLAIN QUERY PLAN " + publishedCache).all(...publishedHashes);
      db.exec("CREATE INDEX chunks_text_hash ON chunks(hash); DROP INDEX chunks_hash");
      assert.equal(db.prepare(publishedCache).all(...publishedHashes).length, 16, "Each text hash must select one vector despite multiple published owners");
      const hashes = db.prepare("SELECT hash FROM staging WHERE conversation_id=? ORDER BY ordinal LIMIT 16").all("partial-plan").map((row) => {
        assert.ok(typeof row.hash === "string"); return row.hash;
      });
      const stagedCache = `SELECT hash,embedding FROM staging WHERE conversation_id=? AND hash IN (${hashes.map(() => "?").join(",")}) GROUP BY hash`;
      db.exec("DROP INDEX staging_hash");
      const before = db.prepare("EXPLAIN QUERY PLAN " + stagedCache).all("partial-plan", ...hashes);
      db.exec("CREATE INDEX staging_hash ON staging(conversation_id,hash)");
      const staged = db.prepare(stagedCache).all("partial-plan", ...hashes);
      assert.equal(staged.length, 16);
      const run = db.prepare("SELECT run FROM staging WHERE conversation_id=? LIMIT 1").get("partial-plan")?.run;
      assert.ok(typeof run === "string");
      const plans = {
        exact: db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT chunk_id FROM source_refs WHERE ref IN (?) LIMIT ?").all("mail:synthetic:10", 20),
        fts: db.prepare("EXPLAIN QUERY PLAN SELECT rowid AS id,rank AS value FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?").all('"maintenance"', 20),
        dense: db.prepare("EXPLAIN QUERY PLAN SELECT rowid AS id,distance AS value FROM chunk_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance").all(new Uint8Array(new Float32Array([1, 0, 0]).buffer), 20),
        publishedCacheBefore: publishedBefore,
        globalCacheBeforeHashIndex: globalBefore,
        publishedCache: db.prepare("EXPLAIN QUERY PLAN " + publishedCache).all(...publishedHashes),
        publishedDelete: db.prepare("EXPLAIN QUERY PLAN DELETE FROM chunks WHERE conversation_id=?").all("representative"),
        stagingBeforeHashIndex: before,
        stagingCache: db.prepare("EXPLAIN QUERY PLAN " + stagedCache).all("partial-plan", ...hashes),
        stagingPublish: db.prepare(`EXPLAIN QUERY PLAN INSERT INTO chunks(conversation_id,entry_id,ordinal,part,hash,text,source_refs)
          SELECT conversation_id,entry_id,ordinal,part,hash,text,source_refs FROM staging WHERE conversation_id=? AND run=? ORDER BY ordinal,part`).all("partial-plan", run),
        vectorPublish: db.prepare(`EXPLAIN QUERY PLAN INSERT INTO chunk_vectors(rowid,embedding)
          SELECT c.id,s.embedding FROM staging s JOIN chunks c ON c.conversation_id=s.conversation_id AND c.entry_id=s.entry_id AND c.part=s.part
          WHERE s.conversation_id=? AND s.run=?`).all("partial-plan", run),
        stagingCleanup: db.prepare("EXPLAIN QUERY PLAN DELETE FROM staging WHERE conversation_id=?").all("partial-plan"),
        cascadeDelete: db.prepare("EXPLAIN QUERY PLAN DELETE FROM conversations WHERE id=?").all("partial-plan"),
      };
      t.diagnostic(JSON.stringify(plans));
      const count = db.prepare("SELECT count(*) AS count FROM chunks").get()?.count;
      assert.ok(typeof count === "number" && count > 1000);
      assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vectors").get()?.count, count);
    } finally { db.close(); }
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});
