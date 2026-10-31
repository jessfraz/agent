import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SearchIndex, type Embed, type SearchRecord } from "../src/search.js";

const embed: Embed = async (texts) => ({ space: { id: "layout", model_revision: "fixture", model_digest: "fixture",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 }, vectors: texts.map(() => [1, 0, 0]) });
async function* records(extra = false): AsyncIterable<SearchRecord> {
  yield { entry_id: "first", ordinal: 0, text: "Automobile service history", source_refs: ["mail:synthetic:layout"] };
  if (extra) for (let ordinal = 1; ordinal < 16; ordinal++) {
    yield { entry_id: ordinal === 1 ? "second" : `extra-${ordinal}`, ordinal,
      text: `Automobile tire replacement ${ordinal}`, source_refs: [] };
  }
}

test("new vector projections use large pages without changing an existing database layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-index-layout-"));
  try {
    for (const existing of [false, true]) {
      const path = join(directory, existing ? "existing.sqlite" : "new.sqlite");
      if (existing) {
        const db = new DatabaseSync(path);
        try { db.exec("PRAGMA page_size=4096; CREATE TABLE existing_data(id INTEGER PRIMARY KEY)"); }
        finally { db.close(); }
      }
      const index = new SearchIndex(path);
      try { await index.upsert("service", "one", records(), embed); }
      finally { await index.close(); }
      const db = new DatabaseSync(path, { readOnly: true });
      try { assert.equal(db.prepare("PRAGMA page_size").get()?.page_size, existing ? 4096 : 65536); }
      finally { db.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native SQLite compaction preserves published identities and interrupted staged vectors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-index-compaction-")), path = join(directory, "search.sqlite");
  const seed = new DatabaseSync(path);
  seed.exec("PRAGMA page_size=4096; CREATE TABLE existing_data(id INTEGER PRIMARY KEY)"); seed.close();
  let index = new SearchIndex(path);
  try {
    await index.upsert("service", "one", records(), embed);
    async function* interrupted(): AsyncIterable<SearchRecord> { yield* records(true); throw new Error("Source interrupted"); }
    await assert.rejects(index.upsert("service", "two", interrupted(), embed), /Source interrupted/);
    const before = await index.search("Automobile", embed);
    await index.close();
    const db = new DatabaseSync(path, { allowExtension: true });
    const extension = process.env.AGENT_SQLITE_VEC; assert.ok(extension); db.loadExtension(extension);
    const projection = () => ({
      chunks: db.prepare("SELECT c.id,c.entry_id,c.ordinal,c.text,c.source_refs,v.embedding FROM chunks c JOIN chunk_vectors v ON v.rowid=c.id ORDER BY c.id").all(),
      checkpoints: db.prepare("SELECT * FROM conversations ORDER BY id").all(),
      staging: db.prepare("SELECT * FROM staging ORDER BY conversation_id,entry_id,part").all(),
    });
    try {
      const original = projection();
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA page_size=65536; VACUUM; PRAGMA journal_mode=WAL");
      assert.equal(db.prepare("PRAGMA page_size").get()?.page_size, 65536);
      assert.deepEqual(projection(), original);
      assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally { db.close(); }
    index = new SearchIndex(path);
    assert.deepEqual(await index.search("Automobile", embed), before);
    await index.upsert("service", "two", records(true), async () => { throw new Error("Compaction must preserve cached vectors"); });
    assert.deepEqual(index.checkpoint("service"), { watermark: "two", dirty: false });
    assert.equal((await index.search("replacement", undefined, [], 8, "keyword")).candidates[0]?.matches[0]?.entry_id, "second");
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});
