import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  } finally { index.close(); }
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
  } finally { index.close(); }
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
    index.close(); index = new SearchIndex(path);
    await index.reconcile(inventory([{ conversation_id: "service", watermark: "40" }]), () => records([...data, record("new", "The bicycle is fixed", 38)]), embedding);
    assert.deepEqual(index.checkpoint("service"), { watermark: "40", dirty: false });
    assert.equal(batches.at(-1), 1);
    fail = true;
    const lexical = await index.search("Automobile", embedding);
    assert.ok(lexical.candidates.length > 0); assert.deepEqual(lexical.gaps, ["Runner unavailable"]);
    await index.reconcile(inventory([]), () => records([]), embedding);
    assert.equal(index.checkpoint("service"), undefined);
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
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
    await began; index.markDirty("work"); release(); await indexing;
    assert.deepEqual(index.checkpoint("work"), { watermark: "two", dirty: true });
    await index.reconcile(inventory([{ conversation_id: "work", watermark: "three" }]), () => records([record("three", "Latest note")]), embedding);
    assert.deepEqual(index.checkpoint("work"), { watermark: "three", dirty: false });
    // No markDirty call: startup inventory must still detect the native tail change.
    await index.reconcile(inventory([{ conversation_id: "work", watermark: "four" }]), () => records([record("four", "A missed commit")]), embedding);
    assert.equal((await index.search("missed", embedding)).candidates[0]?.matches[0]?.entry_id, "four");
  } finally { release(); index.close(); }
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
  } finally { release(); index.close(); }
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
  } finally { index.close(); }
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
    const db = new DatabaseSync(path, { allowExtension: true });
    try {
      assert.ok(process.env.AGENT_SQLITE_VEC); db.loadExtension(process.env.AGENT_SQLITE_VEC);
      const plans = {
        exact: db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT chunk_id FROM source_refs WHERE ref IN (?) LIMIT ?").all("mail:synthetic:10", 20),
        fts: db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?").all('"maintenance"', 20),
        dense: db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM chunk_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance").all(new Uint8Array(new Float32Array([1, 0, 0]).buffer), 20),
        cache: db.prepare("EXPLAIN QUERY PLAN SELECT c.hash,v.embedding FROM chunks c JOIN chunk_vectors v ON v.rowid=c.id WHERE c.conversation_id=? AND c.hash IN (?)").all("representative", "synthetic"),
      };
      t.diagnostic(JSON.stringify(plans));
      const count = db.prepare("SELECT count(*) AS count FROM chunks").get()?.count;
      assert.ok(typeof count === "number" && count > 1000);
      assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vectors").get()?.count, count);
    } finally { db.close(); }
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
});
