import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openConversationDatabase } from "../src/conversation-database.js";
import { CoordinatorEnvironment } from "../src/environment.js";
import type { SourceBatch } from "../src/generated/SourceBatch.js";
import { ConversationModels } from "../src/models.js";
import { conversationSettings } from "../src/settings.js";
import { SourceJournal } from "../src/sources.js";
import { TaskStore } from "../src/tasks.js";

async function open(path: string) {
  const database = await openConversationDatabase(path);
  const storage = await SqliteStorage.open(database);
  const session = await Harness.open(storage,
    { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels());
  const sources = new SourceJournal(session, tasks);
  const environment = new CoordinatorEnvironment(session);
  return { database, storage, session, tasks, sources, environment };
}

function batch(text: string, count = 64): SourceBatch {
  const source = { provider: "mail", account: "retained" };
  return { source, checkpoint: { value: "retained-page" }, coverage: { status: "complete" },
    events: Array.from({ length: count }, (_, index) => ({ id: `message-${Math.floor(index / 2)}`, version: `v${index % 2 + 1}`,
      source: { ...source, thread_id: `thread-${Math.floor(index / 2)}` }, title: `Retained event ${index}`, text })) };
}

const latestRevision = "SELECT kind, length(CAST(content AS BLOB)) AS bytes FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1";

test("a source decision persists only its delta while settings read beside a large retained journal", { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-journal-performance-")), path = join(directory, "session.sqlite");
  // The ordinary regression stays small. Qualification also runs this same
  // native path with the observed 366 MB retained journal, without a model.
  const bytes = Number(process.env.AGENT_SOURCE_JOURNAL_BYTES ?? 4 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 64);
  const count = 64, phrase = "Retained source evidence. ", size = Math.ceil(bytes / count);
  const original = batch(phrase.repeat(Math.ceil(size / phrase.length)).slice(0, size), count);
  let app = await open(path);
  try {
    await app.sources.admit(original, null);
    const records = await app.sources.events({ limit: 100 });
    const selected = records[0]; assert.ok(selected);
    const sourceDocument = (await app.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: "agent.sources" },
      1, undefined, BACKGROUND_CONTEXT)).items[0]; assert.ok(sourceDocument);
    const before = await app.database.get<{ kind: string; bytes: number }>(latestRevision, sourceDocument.id); assert.ok(before);
    assert.equal(before.kind, "base");
    assert.ok(before.bytes >= bytes, "The real persisted journal must contain the requested retained payload");
    const settings = () => conversationSettings(app.tasks, app.environment,
      { type: "conversation_settings", task_id: null, agent_id: null, change: null, catalog: false });
    const expectedSettings = await settings();
    const plan = await app.database.all<{ detail: string }>("EXPLAIN QUERY PLAN " + latestRevision, sourceDocument.id);
    const measure = async (stage: string) => {
      const began = performance.now();
      const decision = app.sources.decide([selected.key], { type: "dismissed", reason: stage });
      const reading = settings().then(value => ({ value, elapsed_ms: performance.now() - began }));
      await decision;
      const decisionMs = performance.now() - began;
      const read = await reading;
      assert.deepEqual(read.value, expectedSettings);
      const revision = await app.database.get<{ kind: string; bytes: number }>(latestRevision, sourceDocument.id); assert.ok(revision);
      t.diagnostic(JSON.stringify({ stage, retained_bytes: before.bytes, decision_ms: decisionMs, settings_ms: read.elapsed_ms,
        revision_kind: revision.kind, revision_bytes: revision.bytes, plan: plan.map(row => row.detail) }));
      assert.equal(revision.kind, "delta", "A one-key judgment must not rewrite the retained source corpus");
      assert.ok(revision.bytes < 4096, "Persisted work must be bounded by the decision rather than retained evidence");
    };
    await measure("Initial judgment");
    for (let index = 1; index < 64; index += 1) {
      await app.sources.decide([selected.key], { type: "dismissed", reason: `Judgment ${index}` });
    }
    // A periodic 64-delta policy makes this next tiny change rewrite the entire
    // retained corpus. Measure that boundary beside the same real settings read.
    await measure("Judgment after 64 deltas");
    await app.session.close(BACKGROUND_CONTEXT);
    const reopening = performance.now(); app = await open(path);
    const restored = await app.sources.events({ limit: 100 });
    t.diagnostic(JSON.stringify({ cold_replay_ms: performance.now() - reopening, retained_bytes: before.bytes, decisions: 65 }));
    assert.deepEqual(restored.map(record => ({ key: record.key, event: record.event })),
      records.map(record => ({ key: record.key, event: record.event })), "Reopening preserves every original and version identity");
    assert.deepEqual(restored.find(record => record.key === selected.key)?.decision,
      { type: "dismissed", reason: "Judgment after 64 deltas" });
    assert.equal(restored.filter(record => record.decision === null).length, original.events.length - 1);
    assert.deepEqual((await app.sources.states()).find(state => state.source.provider === "mail")?.checkpoint, original.checkpoint);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("source decisions retain atomic version judgments through a long native delta replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-journal-checkpoint-")), path = join(directory, "session.sqlite");
  let app = await open(path);
  try {
    await app.sources.admit(batch("Immutable original", 2), null);
    const original = await app.sources.events({ limit: 100 }), states = await app.sources.states();
    const keys = original.map(record => record.key);
    for (let index = 0; index < 70; index += 1) {
      await app.sources.decide(keys, { type: "dismissed", reason: `Reviewed both versions ${index}` });
      if (index === 31) { await app.session.close(BACKGROUND_CONTEXT); app = await open(path); }
    }
    const document = (await app.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: "agent.sources" },
      1, undefined, BACKGROUND_CONTEXT)).items[0]; assert.ok(document);
    const saved = await app.storage.document(document.id, "current", BACKGROUND_CONTEXT); assert.ok(saved);
    assert.equal(saved.deltasSinceBase, 70, "Small judgments must remain incremental beyond a periodic checkpoint boundary");
    const settled = await app.sources.events({ limit: 100 });
    await assert.rejects(app.sources.decide([...keys, "missing-version"], { type: "dismissed", reason: "Must roll back" }), /Unknown source event/u);
    assert.deepEqual(await app.sources.events({ limit: 100 }), settled, "A failed multi-key decision cannot partially change a version");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(path);
    const restored = await app.sources.events({ limit: 100 });
    assert.deepEqual(restored.map(record => ({ key: record.key, event: record.event })),
      original.map(record => ({ key: record.key, event: record.event })));
    assert.ok(restored.every(record => record.decision?.type === "dismissed" && record.decision.reason === "Reviewed both versions 69"));
    assert.deepEqual(await app.sources.states(), states);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
