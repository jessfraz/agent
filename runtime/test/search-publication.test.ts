import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";
import { SearchIndex, type Embed, type SearchRecord } from "../src/search.js";

const space: EmbeddingSpace = { id: "publication-lock", model_revision: "fixture", model_digest: "fixture",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 };
const embed: Embed = async (texts) => ({ space, vectors: texts.map(() => [1, 0, 0]) });
type Publication = { status: "published" } | { status: "failed"; error: unknown };
async function* records(prefix: string, text = "Automobile maintenance evidence"): AsyncIterable<SearchRecord> {
  for (let ordinal = 0; ordinal < 16; ordinal++) yield { entry_id: `${prefix}-${ordinal}`, ordinal,
    text: `${text} ${ordinal}`, source_refs: ["mail:synthetic:" + prefix] };
}

test("a contended publication leaves the event loop and prior keyword snapshot available", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-publication-lock-")), path = join(directory, "search.sqlite");
  const index = new SearchIndex(path), extension = process.env.AGENT_SQLITE_VEC; assert.ok(extension);
  const writer = new DatabaseSync(path, { allowExtension: true });
  writer.loadExtension(extension); writer.enableLoadExtension(false);
  let locked = false, settled = false, acquired = () => {};
  const barrier = new Promise<void>((resolve) => { acquired = resolve; });
  let publishing: Promise<Publication> | undefined;
  try {
    await index.upsert("service", "one", records("original"), embed);
    const original = await index.search("Automobile", undefined, [], 8, "keyword");
    assert.equal(original.candidates[0]?.conversation_id, "service");
    async function* replacement(): AsyncIterable<SearchRecord> {
      yield* records("replacement");
      // The final full batch is durable before the producer is asked for EOF.
      // This real writer now owns the lock publication must wait to acquire.
      writer.exec("BEGIN IMMEDIATE"); locked = true;
      assert.equal(writer.prepare("SELECT count(*) AS count FROM staging WHERE conversation_id=?").get("service")?.count, 16);
      acquired();
    }
    publishing = index.upsert("service", "two", replacement(), async () => {
      throw new Error("All publication vectors must come from the real saved cache");
    }).then(
      (): Publication => { settled = true; return { status: "published" }; },
      (error: unknown): Publication => { settled = true; return { status: "failed", error }; },
    );
    await Promise.race([barrier, publishing.then((outcome) => {
      if (outcome.status === "failed") throw outcome.error;
      throw new Error("Publication finished before the writer acquired its barrier");
    })]);
    const during = await index.search("Automobile", undefined, [], 8, "keyword");
    assert.equal(settled, false, "Keyword context must complete while publication still waits on the real writer");
    assert.deepEqual(during.candidates, original.candidates);
    assert.deepEqual(during.gaps, ["1 conversations await indexing"]);
    assert.deepEqual(index.checkpoint("service"), { watermark: "one", dirty: true });
    writer.exec("COMMIT"); locked = false;
    const outcome = await publishing;
    if (outcome.status === "failed") throw outcome.error;
    assert.deepEqual(index.checkpoint("service"), { watermark: "two", dirty: false });
    const current = await index.search("Automobile", undefined, [], 8, "keyword");
    assert.equal(current.candidates[0]?.conversation_id, "service");
    assert.ok(current.candidates[0]?.matches.length);
    assert.ok(current.candidates[0]?.matches.every((match) => match.entry_id.startsWith("replacement-")
      && match.source_refs.length === 1 && match.source_refs[0] === "mail:synthetic:replacement"));
  } finally {
    if (locked) writer.exec("ROLLBACK");
    await publishing;
    writer.close(); await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing a contended publication retains the complete prior view and reusable staged vectors", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-publication-close-")), path = join(directory, "search.sqlite");
  let index = new SearchIndex(path);
  const extension = process.env.AGENT_SQLITE_VEC; assert.ok(extension);
  const writer = new DatabaseSync(path, { allowExtension: true });
  writer.loadExtension(extension); writer.enableLoadExtension(false);
  let locked = false, settled = false, acquired = () => {};
  const barrier = new Promise<void>((resolve) => { acquired = resolve; });
  let publishing: Promise<Publication> | undefined, closing: Promise<void> | undefined;
  const replacementText = "Automobile revised maintenance evidence";
  try {
    await index.upsert("service", "one", records("original"), embed);
    const original = await index.search("Automobile", undefined, [], 8, "keyword");
    async function* replacement(): AsyncIterable<SearchRecord> {
      // These texts have no published vectors. A retry must reuse staging.
      yield* records("replacement", replacementText);
      writer.exec("BEGIN IMMEDIATE"); locked = true;
      assert.equal(writer.prepare("SELECT count(*) AS count FROM staging WHERE conversation_id=?").get("service")?.count, 16);
      acquired();
    }
    publishing = index.upsert("service", "two", replacement(), embed).then(
      (): Publication => { settled = true; return { status: "published" }; },
      (error: unknown): Publication => { settled = true; return { status: "failed", error }; },
    );
    await Promise.race([barrier, publishing.then((outcome) => {
      if (outcome.status === "failed") throw outcome.error;
      throw new Error("Publication finished before the writer acquired its barrier");
    })]);
    const during = await index.search("Automobile", undefined, [], 8, "keyword");
    assert.deepEqual(during.candidates, original.candidates);
    assert.deepEqual(during.gaps, ["1 conversations await indexing"]);
    assert.equal(settled, false);
    closing = index.close();
    const outcome = await publishing;
    assert.equal(outcome.status, "failed", "Close must reject the mutation while its external lock remains held");
    if (outcome.status === "failed") assert.match(String(outcome.error), /closed/);
    assert.equal(locked, true);
    writer.exec("ROLLBACK"); locked = false;
    await closing;
    index = new SearchIndex(path);
    assert.deepEqual(index.checkpoint("service"), { watermark: "one", dirty: true });
    const reopened = await index.search("Automobile", undefined, [], 8, "keyword");
    assert.deepEqual(reopened.candidates, original.candidates);
    assert.deepEqual(reopened.gaps, ["1 conversations await indexing"]);
    assert.deepEqual(writer.prepare("SELECT entry_id FROM chunks WHERE conversation_id=? ORDER BY ordinal").all("service")
      .map((row) => row.entry_id), Array.from({ length: 16 }, (_, ordinal) => `original-${ordinal}`));
    assert.equal(writer.prepare("SELECT count(*) AS count FROM staging WHERE conversation_id=?").get("service")?.count, 16);
    await index.upsert("service", "two", records("replacement", replacementText), async () => {
      throw new Error("Reopening must reuse every durable staged vector without embedding again");
    });
    assert.deepEqual(index.checkpoint("service"), { watermark: "two", dirty: false });
    const current = await index.search("Automobile", undefined, [], 8, "keyword");
    assert.ok(current.candidates[0]?.matches.length);
    assert.ok(current.candidates[0]?.matches.every((match) => match.entry_id.startsWith("replacement-")));
    assert.equal(writer.prepare("SELECT count(*) AS count FROM staging WHERE conversation_id=?").get("service")?.count, 0);
  } finally {
    if (locked) writer.exec("ROLLBACK");
    await publishing; await closing;
    writer.close(); await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent deletion and invalidation release a contended writer without blocking each other", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-publication-race-")), path = join(directory, "search.sqlite");
  const index = new SearchIndex(path), writer = new DatabaseSync(path);
  let locked = false;
  let deleting: Promise<Publication> | undefined, invalidating: Promise<Publication> | undefined;
  async function outcome(action: () => void | Promise<void>): Promise<Publication> {
    try { await action(); return { status: "published" }; }
    catch (error) { return { status: "failed", error }; }
  }
  try {
    await index.upsert("delete-me", "one", records("original"), embed);
    writer.exec("BEGIN IMMEDIATE"); locked = true;
    // Only the event loop can release this real lock. Both mutations must
    // remain asynchronous even before the queued deletion starts publishing.
    const released = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try { writer.exec("ROLLBACK"); locked = false; resolve(); }
        catch (error) { reject(error); }
      });
    });
    deleting = outcome(() => index.delete("delete-me"));
    invalidating = outcome(() => index.markDirty("invalidate"));
    const [deleted, invalidated] = await Promise.all([deleting, invalidating, released]);
    if (deleted.status === "failed") throw deleted.error;
    if (invalidated.status === "failed") throw invalidated.error;
    assert.equal(index.checkpoint("delete-me"), undefined);
    assert.deepEqual(index.checkpoint("invalidate"), { watermark: "", dirty: true });
    assert.deepEqual((await index.search("Automobile", undefined, [], 8, "keyword")).candidates, []);
  } finally {
    if (locked) writer.exec("ROLLBACK");
    await deleting; await invalidating;
    writer.close(); await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("incremental publication retains unchanged rowids, vectors and corrected provenance across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-publication-incremental-")), path = join(directory, "search.sqlite");
  let index = new SearchIndex(path);
  const extension = process.env.AGENT_SQLITE_VEC; assert.ok(extension);
  const reader = new DatabaseSync(path, { readOnly: true, allowExtension: true });
  reader.loadExtension(extension); reader.enableLoadExtension(false); reader.exec("PRAGMA query_only=ON");
  const initial: SearchRecord[] = [
    { entry_id: "retained", ordinal: 0, text: "Automobile maintenance evidence", source_refs: ["mail:synthetic:original"] },
    { entry_id: "revised", ordinal: 1, text: "Oscilloscope repair evidence", source_refs: ["mail:synthetic:repair"] },
    { entry_id: "removed", ordinal: 2, text: "Waveform inspection evidence", source_refs: ["mail:synthetic:waveform"] },
  ];
  const appended: SearchRecord = { entry_id: "appended", ordinal: 3, text: "Previously embedded reference evidence",
    source_refs: ["mail:synthetic:append"] };
  const embeddingCalls: string[][] = [];
  const embedding: Embed = async (texts, purpose) => {
    assert.equal(purpose, "document"); embeddingCalls.push(texts);
    return { space, vectors: texts.map(() => [1, 0, 0]) };
  };
  const cachedOnly: Embed = async () => { throw new Error("Published document embeddings must survive reopen and be reused"); };
  async function* stream(items: SearchRecord[]): AsyncIterable<SearchRecord> { yield* items; }
  function published(conversation = "owner") {
    return reader.prepare(`SELECT c.id,c.entry_id,c.ordinal,c.part,c.source_refs,v.embedding FROM chunks c
      JOIN chunk_vectors v ON v.rowid=c.id WHERE c.conversation_id=? ORDER BY c.ordinal,c.part`).all(conversation).map((row) => {
      assert.ok(typeof row.id === "number" && typeof row.entry_id === "string"
        && typeof row.ordinal === "number" && typeof row.part === "number" && typeof row.source_refs === "string");
      assert.ok(row.embedding instanceof Uint8Array);
      return { id: row.id, entry_id: row.entry_id, ordinal: row.ordinal, part: row.part,
        source_refs: row.source_refs, embedding: Buffer.from(row.embedding) };
    });
  }
  function entry(rows: ReturnType<typeof published>, id: string) {
    const row = rows.find((row) => row.entry_id === id); assert.ok(row); return row;
  }
  async function reopen(watermark: string) {
    assert.deepEqual(index.checkpoint("owner"), { watermark, dirty: false });
    await index.close(); index = new SearchIndex(path);
    assert.deepEqual(index.checkpoint("owner"), { watermark, dirty: false });
    assert.equal(reader.prepare("SELECT count(*) AS count FROM staging WHERE conversation_id=?").get("owner")?.count, 0);
  }
  try {
    await index.upsert("discard", "one", stream([
      { entry_id: "gap-0", ordinal: 0, text: "Disposable first evidence", source_refs: [] },
      { entry_id: "gap-1", ordinal: 1, text: "Disposable second evidence", source_refs: [] },
    ]), embedding);
    await index.upsert("owner", "one", stream(initial), embedding);
    // A later owner prevents SQLite from accidentally reusing the highest
    // rowids when an old implementation deletes and reinserts this owner.
    await index.upsert("anchor", "one", stream([{ ...appended, entry_id: "anchor", ordinal: 0,
      source_refs: ["mail:synthetic:anchor"] }]), embedding);
    await index.delete("discard");
    const original = published(), anchor = published("anchor"), callsBeforeAppend = embeddingCalls.length;
    assert.ok(original.every((row) => row.id > 2));

    await index.upsert("owner", "appended", stream([...initial, appended]), cachedOnly);
    await reopen("appended");
    const afterAppend = published();
    for (const before of original) {
      const after = entry(afterAppend, before.entry_id);
      assert.equal(after.id, before.id, "Appending must preserve existing chunk row IDs");
      assert.deepEqual(after.embedding, before.embedding);
    }
    assert.deepEqual(entry(afterAppend, "appended").embedding, entry(anchor, "anchor").embedding);
    assert.equal(embeddingCalls.length, callsBeforeAppend);

    const corrected: SearchRecord[] = [
      { ...initial[0]!, ordinal: 7, source_refs: ["mail:synthetic:corrected", "issue:synthetic:42"] },
      { ...initial[1]!, ordinal: 8, text: "Calibration replacement evidence" },
      { ...initial[2]!, ordinal: 9 },
      { ...appended, ordinal: 10 },
    ];
    await index.upsert("owner", "corrected", stream(corrected), async (texts, purpose) => {
      assert.equal(purpose, "document"); assert.deepEqual(texts, ["Calibration replacement evidence"]);
      return { space, vectors: [[0, 1, 0]] };
    });
    await reopen("corrected");
    const afterCorrection = published();
    for (const id of ["retained", "removed", "appended"]) {
      assert.equal(entry(afterCorrection, id).id, entry(afterAppend, id).id);
      assert.deepEqual(entry(afterCorrection, id).embedding, entry(afterAppend, id).embedding);
    }
    const retained = entry(afterCorrection, "retained");
    assert.equal(retained.ordinal, 7);
    assert.equal(retained.source_refs, JSON.stringify(["issue:synthetic:42", "mail:synthetic:corrected"]));
    assert.deepEqual(reader.prepare("SELECT ref FROM source_refs WHERE chunk_id=? ORDER BY ref").all(retained.id)
      .map((row) => row.ref), ["issue:synthetic:42", "mail:synthetic:corrected"]);
    assert.equal(reader.prepare("SELECT count(*) AS count FROM source_refs WHERE ref=?").get("mail:synthetic:original")?.count, 0);
    assert.deepEqual(entry(afterCorrection, "revised").embedding, Buffer.from(new Float32Array([0, 1, 0]).buffer));
    assert.deepEqual((await index.search("Oscilloscope", undefined, [], 8, "keyword")).candidates, []);
    assert.equal((await index.search("Calibration", undefined, [], 8, "keyword")).candidates[0]?.matches[0]?.entry_id, "revised");

    await index.upsert("owner", "trimmed", stream(corrected.filter((record) => record.entry_id !== "removed")), cachedOnly);
    await reopen("trimmed");
    const afterRemoval = published(), removed = entry(afterCorrection, "removed");
    assert.deepEqual(afterRemoval, afterCorrection.filter((record) => record.entry_id !== "removed"));
    assert.equal(reader.prepare("SELECT rowid FROM chunk_vectors WHERE rowid=?").get(removed.id), undefined);
    assert.equal(reader.prepare("SELECT count(*) AS count FROM source_refs WHERE chunk_id=?").get(removed.id)?.count, 0);
    assert.deepEqual(reader.prepare("SELECT rowid AS id FROM chunk_vectors ORDER BY rowid").all().map((row) => row.id),
      reader.prepare("SELECT id FROM chunks ORDER BY id").all().map((row) => row.id));
    assert.deepEqual(published("anchor"), anchor);
  } finally {
    reader.close(); await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
