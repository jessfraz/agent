import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SourceRef } from "../src/generated/SourceRef.js";
import { ConversationModels } from "../src/models.js";
import { SearchIndex, type Embed, type SearchRecord } from "../src/search.js";
import { sourceReference, TaskStore } from "../src/tasks.js";
import { fixtureModel } from "./model.js";

const embed: Embed = async (texts) => ({ space: { id: "synthetic-source-provenance", model_revision: "fixture", model_digest: "fixture",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 }, vectors: texts.map(() => [1, 0, 0]) });

test("task search retains every source across indexing and reopen for a conversation with many linked threads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-provenance-")); const path = join(directory, "search.sqlite");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models));
  const sources: SourceRef[] = Array.from({ length: 1244 }, (_, index) => ({ provider: "mail", account: "fixture", thread_id: `thread-${index}` }));
  const refs = sources.map(sourceReference).sort();
  try {
    const task = await tasks.create({ title: "Vehicle maintenance", outcome: "Close the linked service requests", sources, model: fixtureModel });
    const conversation = await tasks.conversation(task.conversation_id);
    await tasks.inference.configure(conversation, fixtureModel, { instructions: "Record the service decision." });
    for (let turn = 0; turn < 8; turn += 1) {
      faux.setResponses([fauxAssistantMessage(`Service decision ${turn} retained.`)]);
      const settled = await (await conversation.submit({ type: "input", content: `Automobile service decision ${turn}. `.repeat(200) }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      assert.equal(settled.status, "done");
    }
    const records: SearchRecord[] = []; for await (const record of tasks.records(task.conversation_id)) records.push(record);
    assert.ok(records.length >= 16); assert.ok(records.some((record) => Buffer.byteLength(record.text) > 4096));
    assert.ok(records.every((record) => record.source_refs.length === sources.length));
    const watermark = records.at(-1)?.entry_id; assert.ok(watermark);
    const expectedEntries = new Set(records.map((record) => record.entry_id));
    let index = new SearchIndex(path);
    try {
      const started = performance.now(); await index.upsert(task.conversation_id, watermark, tasks.records(task.conversation_id), embed);
      t.diagnostic(JSON.stringify({ references_per_entry: refs.length, records: records.length, index_ms: performance.now() - started }));
      assert.deepEqual(index.checkpoint(task.conversation_id), { watermark, dirty: false });
    } finally { await index.close(); }
    index = new SearchIndex(path);
    try {
      const started = performance.now();
      for (const ref of [sourceReference(sources[0]!), sourceReference(sources.at(-1)!)]) {
        const result = await index.search("", embed, [ref]); assert.deepEqual(result.gaps, []);
        assert.equal(result.candidates[0]?.conversation_id, task.conversation_id);
        for (const match of result.candidates[0]?.matches ?? []) {
          assert.ok(expectedEntries.has(match.entry_id)); assert.deepEqual(match.source_refs, refs);
        }
      }
      t.diagnostic(JSON.stringify({ exact_queries: 2, query_ms: performance.now() - started }));
      const semantic = await index.search("transport maintenance", embed);
      assert.equal(semantic.candidates[0]?.conversation_id, task.conversation_id);
      assert.ok(semantic.candidates[0]?.matches.some((match) => match.text.includes("Automobile")));
      const keyword = await index.search("Automobile", embed, [], 8, "keyword");
      assert.equal(keyword.candidates[0]?.conversation_id, task.conversation_id);
      assert.ok(keyword.candidates[0]?.matches.some((match) => match.text.includes("Automobile")));
    } finally { await index.close(); }
    const db = new DatabaseSync(path);
    try {
      const chunks = db.prepare("SELECT count(*) AS count FROM chunks").get()?.count; assert.ok(typeof chunks === "number" && chunks > records.length);
      assert.equal(db.prepare("SELECT count(*) AS count FROM source_refs").get()?.count, chunks * refs.length);
      const query = "SELECT DISTINCT chunk_id AS id FROM source_refs WHERE ref IN (?) LIMIT ?";
      const plan = db.prepare("EXPLAIN QUERY PLAN " + query).all(refs.at(-1)!, 80);
      assert.ok(db.prepare(query).all(refs.at(-1)!, 80).length > 0);
      t.diagnostic(JSON.stringify({ chunks, source_rows: chunks * refs.length, exact_query_plan: plan }));
    } finally { db.close(); }
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
