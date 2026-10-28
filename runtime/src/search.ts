import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { EmbeddingBatch } from "./generated/EmbeddingBatch.js";
import type { EmbeddingPurpose } from "./generated/EmbeddingPurpose.js";
import type { EmbeddingSpace } from "./generated/EmbeddingSpace.js";
import type { SearchMode } from "./generated/SearchMode.js";

export type SearchRecord = { entry_id: string; ordinal: number; text: string; source_refs: string[] };
export type SearchWatermark = { conversation_id: string; watermark: string };
export type SearchMatch = { entry_id: string; text: string; source_refs: string[] };
export type SearchCandidate = { conversation_id: string; score: number; matches: SearchMatch[] };
export type SearchResult = { candidates: SearchCandidate[]; gaps: string[] };
export type Embed = (texts: string[], purpose: EmbeddingPurpose) => Promise<EmbeddingBatch>;
type Row = Record<string, SQLOutputValue>;
type Chunk = SearchRecord & { part: number; hash: string };
type RankedChunk = { id: number; value: number };
const CHUNKER = "message-utf8-2048-overlap-256-v4";
const BATCH = 16;

function string(row: Row, key: string): string {
  const value = row[key]; if (typeof value !== "string") throw new Error(`Invalid search ${key}`); return value;
}
function number(row: Row, key: string): number {
  const value = row[key]; if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid search ${key}`); return value;
}
function refs(value: string): string[] {
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded) || !decoded.every((item): item is string => typeof item === "string")) throw new Error("Invalid search provenance");
  return decoded;
}
function space(value: unknown): EmbeddingSpace {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !("id" in value) || typeof value.id !== "string" ||
      !("model_revision" in value) || typeof value.model_revision !== "string" ||
      !("model_digest" in value) || typeof value.model_digest !== "string" ||
      !("dimensions" in value) || typeof value.dimensions !== "number" ||
      !("pooling" in value) || typeof value.pooling !== "string" ||
      !("normalization" in value) || typeof value.normalization !== "string" ||
      !("instruction_version" in value) || typeof value.instruction_version !== "number") throw new Error("Invalid saved embedding space; rebuild the search index");
  return { id: value.id, model_revision: value.model_revision, model_digest: value.model_digest,
    dimensions: value.dimensions, pooling: value.pooling, normalization: value.normalization, instruction_version: value.instruction_version };
}
function* chunks(record: SearchRecord): Generator<Chunk> {
  if (record.entry_id.length === 0 || !Number.isSafeInteger(record.ordinal) || record.ordinal < 0) throw new Error("Invalid search record identity");
  const source_refs = [...new Set(record.source_refs)].sort();
  if (source_refs.some((ref) => ref.length === 0 || ref.length > 2048) || source_refs.length > 64) throw new Error("Invalid search source references");
  const bytes = Buffer.from(record.text); let part = 0;
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 2048, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    const text = bytes.subarray(start, end).toString("utf8");
    if (text.trim().length > 0) yield { ...record, text, source_refs, part: part++, hash: createHash("sha256").update(CHUNKER + "\0" + text).digest("hex") };
    if (end === bytes.length) break;
    start = end - 256;
    while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  }
}
function validate(batch: EmbeddingBatch, count: number): void {
  if (!Number.isSafeInteger(batch.space.dimensions) || batch.space.dimensions < 1 || batch.space.dimensions > 4096 ||
      batch.space.id.length === 0 || batch.vectors.length !== count) throw new Error("Invalid embedding space or batch count");
  for (const vector of batch.vectors) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (vector.length !== batch.space.dimensions || vector.some((value) => !Number.isFinite(value)) || Math.abs(norm - 1) >= 0.01) {
      throw new Error("Invalid embedding dimensions, values or normalization");
    }
  }
}

/** Disposable SQLite projections. Pi commits and their source entries remain authoritative. */
export class SearchIndex {
  private readonly db: DatabaseSync;
  private space: EmbeddingSpace | undefined;
  private mutations = Promise.resolve();
  constructor(path: string, extension = process.env.AGENT_SQLITE_VEC) {
    if (extension === undefined || extension.length === 0) throw new Error("sqlite-vec is unavailable; use the Nix installation");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { allowExtension: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.loadExtension(extension); this.db.enableLoadExtension(false);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, watermark TEXT NOT NULL DEFAULT '', dirty INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL, part INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, source_refs TEXT NOT NULL,
        UNIQUE(conversation_id,entry_id,part));
      CREATE INDEX IF NOT EXISTS chunks_text_hash ON chunks(hash);
      DROP INDEX IF EXISTS chunks_hash;
      CREATE TABLE IF NOT EXISTS source_refs(ref TEXT NOT NULL, chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, PRIMARY KEY(ref,chunk_id));
      CREATE INDEX IF NOT EXISTS refs_chunk ON source_refs(chunk_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text,content='chunks',content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',old.id,old.text); END;`);
    // The previous staging table was ephemeral and had no conversation owner.
    if (!this.db.prepare("PRAGMA table_info(staging)").all().some((row) => string(row, "name") === "conversation_id")) this.db.exec("DROP TABLE IF EXISTS staging");
    this.db.exec(`CREATE TABLE IF NOT EXISTS staging(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run TEXT NOT NULL, entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL, part INTEGER NOT NULL,
      hash TEXT NOT NULL, text TEXT NOT NULL, source_refs TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY(conversation_id,entry_id,part));
      CREATE INDEX IF NOT EXISTS staging_hash ON staging(conversation_id,hash);`);
    const saved = this.db.prepare("SELECT value FROM metadata WHERE key='space'").get();
    if (saved !== undefined) {
      this.space = space(JSON.parse(string(saved, "value")));
    }
    const chunker = this.db.prepare("SELECT value FROM metadata WHERE key='chunker'").get();
    if (chunker === undefined || string(chunker, "value") !== CHUNKER) {
      this.db.exec("UPDATE conversations SET dirty=1, revision=revision+1");
      this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('chunker',?)").run(CHUNKER);
    }
  }
  close(): void { this.db.close(); }
  private transaction(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { action(); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private mutate(action: () => Promise<void>): Promise<void> {
    const operation = this.mutations.then(action); this.mutations = operation.catch(() => {}); return operation;
  }
  markDirty(conversation_id: string): void {
    this.db.prepare("INSERT INTO conversations(id) VALUES(?) ON CONFLICT(id) DO UPDATE SET dirty=1,revision=revision+1").run(conversation_id);
  }
  checkpoint(conversation_id: string): { watermark: string; dirty: boolean } | undefined {
    const row = this.db.prepare("SELECT watermark,dirty FROM conversations WHERE id=?").get(conversation_id);
    return row === undefined ? undefined : { watermark: string(row, "watermark"), dirty: number(row, "dirty") !== 0 };
  }
  private setSpace(space: EmbeddingSpace): void {
    if (this.space !== undefined && JSON.stringify(this.space) !== JSON.stringify(space)) throw new Error("Embedding space changed; rebuild the search index");
    if (this.space === undefined) {
      this.transaction(() => {
        this.db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[${space.dimensions}] distance_metric=cosine)`);
        this.db.prepare("INSERT INTO metadata VALUES('space',?)").run(JSON.stringify(space));
      });
      this.space = space;
    }
  }
  upsert(conversation_id: string, watermark: string, records: AsyncIterable<SearchRecord>, embed: Embed): Promise<void> {
    return this.mutate(async () => {
      this.markDirty(conversation_id);
      const revision = number(this.db.prepare("SELECT revision FROM conversations WHERE id=?").get(conversation_id)!, "revision");
      const run = randomUUID(); let pending: Chunk[] = [];
      const stage = async () => {
        if (pending.length === 0) return;
        const batch = pending; pending = [];
        const cached = new Map<string, Uint8Array>();
        if (this.space !== undefined) {
          // Published owners share vector bytes, while each new chunk keeps its own provenance.
          for (const row of this.db.prepare(`SELECT c.hash,v.embedding FROM
            (SELECT hash,min(id) AS id FROM chunks WHERE hash IN (${batch.map(() => "?").join(",")}) GROUP BY hash) c
            JOIN chunk_vectors v ON v.rowid=c.id`).all(...batch.map((chunk) => chunk.hash))) {
            if (!(row.embedding instanceof Uint8Array)) throw new Error("Invalid cached embedding");
            cached.set(string(row, "hash"), row.embedding);
          }
          for (const row of this.db.prepare(`SELECT hash,embedding FROM staging
            WHERE conversation_id=? AND hash IN (${batch.map(() => "?").join(",")}) GROUP BY hash`).all(conversation_id, ...batch.map((chunk) => chunk.hash))) {
            if (!(row.embedding instanceof Uint8Array)) throw new Error("Invalid staged embedding");
            cached.set(string(row, "hash"), row.embedding);
          }
        }
        const missing = [...new Map(batch.filter((chunk) => !cached.has(chunk.hash)).map((chunk) => [chunk.hash, chunk])).values()];
        if (missing.length > 0) {
          const embedded = await embed(missing.map((chunk) => chunk.text), "document"); validate(embedded, missing.length); this.setSpace(embedded.space);
          missing.forEach((chunk, index) => cached.set(chunk.hash, new Uint8Array(new Float32Array(embedded.vectors[index]!).buffer)));
        }
        this.transaction(() => {
          const insert = this.db.prepare(`INSERT INTO staging(conversation_id,run,entry_id,ordinal,part,hash,text,source_refs,embedding) VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(conversation_id,entry_id,part) DO UPDATE SET run=excluded.run,ordinal=excluded.ordinal,hash=excluded.hash,
              text=excluded.text,source_refs=excluded.source_refs,embedding=excluded.embedding WHERE staging.run<>excluded.run`);
          for (const chunk of batch) {
            const written = insert.run(conversation_id, run, chunk.entry_id, chunk.ordinal, chunk.part, chunk.hash, chunk.text,
              JSON.stringify(chunk.source_refs), cached.get(chunk.hash)!);
            if (written.changes !== 1) throw new Error("Search source repeated an entry part");
          }
        });
      };
      // Completed batches survive failure. Only rows observed in this attempt
      // become visible; cached rows removed from the source keep their old tag.
      for await (const record of records) for (const chunk of chunks(record)) { pending.push(chunk); if (pending.length === BATCH) await stage(); }
      await stage();
      this.transaction(() => {
        if (this.space !== undefined) this.db.prepare("DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE conversation_id=?)").run(conversation_id);
        this.db.prepare("DELETE FROM chunks WHERE conversation_id=?").run(conversation_id);
        this.db.prepare(`INSERT INTO chunks(conversation_id,entry_id,ordinal,part,hash,text,source_refs)
          SELECT conversation_id,entry_id,ordinal,part,hash,text,source_refs FROM staging WHERE conversation_id=? AND run=? ORDER BY ordinal,part`).run(conversation_id, run);
        if (this.space !== undefined) this.db.prepare(`INSERT INTO chunk_vectors(rowid,embedding)
          SELECT c.id,s.embedding FROM staging s JOIN chunks c ON c.conversation_id=s.conversation_id AND c.entry_id=s.entry_id AND c.part=s.part
          WHERE s.conversation_id=? AND s.run=?`).run(conversation_id, run);
        this.db.prepare(`INSERT INTO source_refs SELECT j.value,c.id FROM chunks c,json_each(c.source_refs) j WHERE c.conversation_id=?`).run(conversation_id);
        this.db.prepare("UPDATE conversations SET watermark=?,dirty=CASE WHEN revision=? THEN 0 ELSE 1 END WHERE id=?").run(watermark, revision, conversation_id);
        this.db.prepare("DELETE FROM staging WHERE conversation_id=?").run(conversation_id);
      });
    });
  }
  delete(conversation_id: string): Promise<void> {
    return this.mutate(async () => this.transaction(() => {
      if (this.space !== undefined) this.db.prepare("DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE conversation_id=?)").run(conversation_id);
      this.db.prepare("DELETE FROM conversations WHERE id=?").run(conversation_id);
    }));
  }
  async reconcile(inventory: AsyncIterable<SearchWatermark>, records: (id: string) => AsyncIterable<SearchRecord>, embed: Embed): Promise<void> {
    const seen = new Set<string>();
    for await (const item of inventory) {
      seen.add(item.conversation_id); const checkpoint = this.checkpoint(item.conversation_id);
      if (checkpoint?.watermark !== item.watermark || checkpoint.dirty) await this.upsert(item.conversation_id, item.watermark, records(item.conversation_id), embed);
    }
    for (const row of this.db.prepare("SELECT id FROM conversations").all()) if (!seen.has(string(row, "id"))) await this.delete(string(row, "id"));
  }
  async rebuild(inventory: AsyncIterable<SearchWatermark>, records: (id: string) => AsyncIterable<SearchRecord>, embed: Embed): Promise<void> {
    await this.mutate(async () => this.transaction(() => {
      this.db.exec("DELETE FROM conversations; DROP TABLE IF EXISTS chunk_vectors; DELETE FROM metadata WHERE key='space'"); this.space = undefined;
    }));
    await this.reconcile(inventory, records, embed);
  }
  async search(query: string, embed: Embed, source_refs: string[] = [], limit = 8, mode: SearchMode = "semantic"): Promise<SearchResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Search limit must be 1 to 50");
    let dense: RankedChunk[] = []; let lexical: RankedChunk[] = [];
    const gaps: string[] = []; const take = Math.min(200, limit * 10);
    const exactIds = new Set<number>();
    const dirty = this.db.prepare("SELECT count(*) AS count FROM conversations WHERE dirty<>0").get();
    if (dirty !== undefined && number(dirty, "count") > 0) gaps.push(`${number(dirty, "count")} conversations await indexing`);
    try {
      if (query.trim().length > 0) {
        const batch = await embed([query], "query"); validate(batch, 1); this.setSpace(batch.space);
        dense = this.db.prepare("SELECT rowid AS id,distance AS value FROM chunk_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance")
          .all(new Uint8Array(new Float32Array(batch.vectors[0]!).buffer), take).map((row) => ({ id: number(row, "id"), value: number(row, "value") }));
      }
    } catch (error) { gaps.push(error instanceof Error ? error.message : "Semantic retrieval is unavailable"); }
    // No awaits between ranked reads and hydration: a publication may replace/reuse chunk rowids.
    const exact = [...new Set([...source_refs, query.trim()])].filter((ref) => ref.length > 0 && ref.length <= 2048).slice(0, 64);
    if (exact.length > 0) {
      const matches = this.db.prepare(`SELECT DISTINCT chunk_id AS id FROM source_refs WHERE ref IN (${exact.map(() => "?").join(",")}) LIMIT ?`).all(...exact, take).map((row) => number(row, "id"));
      for (const id of matches) exactIds.add(id);
    }
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
    if (tokens.length > 0) lexical = this.db.prepare("SELECT rowid AS id,rank AS value FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR "), take).map((row) => ({ id: number(row, "id"), value: number(row, "value") }));
    const scores = new Map<number, number>();
    const rank = (ids: number[], tier: 1 | 2 | 3) => ids.forEach((id, index) => scores.set(id, tier + 1 / (60 + index + 1)));
    // Incidental word overlap must not displace a semantic match. The other
    // channel breaks equal distances/ranks and fills remaining slots.
    const primary = mode === "semantic" ? dense : lexical;
    const secondary = mode === "semantic" ? lexical : dense;
    const secondaryRanks = new Map(secondary.map((chunk, index) => [chunk.id, index]));
    primary.sort((left, right) => left.value - right.value ||
      (secondaryRanks.get(left.id) ?? take) - (secondaryRanks.get(right.id) ?? take) || left.id - right.id);
    rank(secondary.map((chunk) => chunk.id), 1);
    rank(primary.map((chunk) => chunk.id), 2);
    // Exact source identity outranks either search mode.
    rank([...exactIds].sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left - right), 3);
    if (scores.size === 0) return { candidates: [], gaps };
    const rows = this.db.prepare(`SELECT id,conversation_id,entry_id,text,source_refs FROM chunks WHERE id IN (${[...scores].map(() => "?").join(",")})`).all(...scores.keys());
    const candidates = new Map<string, SearchCandidate>();
    for (const row of rows.sort((left, right) => (scores.get(number(right, "id")) ?? 0) - (scores.get(number(left, "id")) ?? 0))) {
      const id = string(row, "conversation_id"); let candidate = candidates.get(id);
      if (candidate === undefined) { candidate = { conversation_id: id, score: scores.get(number(row, "id")) ?? 0, matches: [] }; candidates.set(id, candidate); }
      const entry_id = string(row, "entry_id");
      if (candidate.matches.length < 3 && !candidate.matches.some((match) => match.entry_id === entry_id)) {
        candidate.matches.push({ entry_id, text: string(row, "text"), source_refs: refs(string(row, "source_refs")) });
      }
    }
    return { candidates: [...candidates.values()].sort((left, right) => right.score - left.score).slice(0, limit), gaps };
  }
}
