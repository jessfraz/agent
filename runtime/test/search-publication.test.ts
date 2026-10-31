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
