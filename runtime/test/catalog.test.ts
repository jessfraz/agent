import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ConversationCatalog } from "../src/catalog.js";
import type { HistoryImportBatch } from "../src/generated/HistoryImportBatch.js";
import { HistoryStore } from "../src/history.js";
import { ConversationModels } from "../src/models.js";
import { validEvent } from "../src/protocol.js";
import { TaskStore } from "../src/tasks.js";
import { fixtureModel } from "./model.js";

function batch(id: string, title: string, updated_at: number, version = "one"): HistoryImportBatch {
  return { host_id: "fixture-source", thread: { id, title, updated_at, created_at: 1, version, version_reliable: true,
    cwd: "/example/project", archived: true, forked_from_id: null, parent_thread_id: null },
    items: [{ id: "one", turn_id: "one", kind: "userMessage", role: "user", text: "TRANSCRIPT_BODY_MUST_NOT_APPEAR",
      version: "one", order: 0, timestamp_ms: 1, data: { type: "userMessage", text: "TRANSCRIPT_BODY_MUST_NOT_APPEAR" }, assets: [] }],
    next_cursor: null, gaps: [], complete: true };
}
class CountingHistory extends HistoryStore {
  lookups = 0;
  override async byConversation(id: string) { this.lookups += 1; return super.byConversation(id); }
}
async function open(path: string) {
  const models = createModels();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(path)),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const histories = new CountingHistory(session), tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(histories);
  return { session, histories, tasks, catalog: new ConversationCatalog(session, histories, tasks) };
}

test("native catalog preserves imported clocks and provenance beside task, child, and main metadata across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-conversation-catalog-"));
  let app = await open(join(directory, "session.sqlite")), closed = false;
  try {
    const old = await app.histories.import(batch("old-source-id", "Old hardware discussion", 1_600_000_000));
    const recent = await app.histories.import(batch("recent-source-id", "Recent hardware discussion", 4_000_000_000));
    const task = await app.tasks.create({ title: "Current hardware task", outcome: "Inspect the current fixture", model: fixtureModel });
    const child = await app.tasks.createAgent(task.id, { id: "fixture-child", title: "Inspect hardware", outcome: "Read the fixture",
      input: "Inspect this fixture", inputId: "fixture-child-input" });
    const root = await app.session.root(BACKGROUND_CONTEXT), rootTime = 1_700_000_000_123;
    await root.submit({ type: "write", entry: { kind: "fixture.main", model: [{ role: "user", content: "Main transcript is not catalog metadata", timestamp: rootTime }] } }, BACKGROUND_CONTEXT);
    const hidden = await app.session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), BACKGROUND_CONTEXT);
    let changed = 0;
    const unsubscribe = app.session.subscribeCommits((publication) => { changed += publication.changes.length; });
    const first = await app.catalog.list("", null, 100); unsubscribe();
    assert.ok(validEvent({ version: 1, id: 1, event: { type: "conversations", ...first } }), "Catalog output must satisfy the generated Rust wire contract");
    assert.equal(changed, 0, "Browsing the catalog must not create tasks, executions, or transcript entries");
    assert.equal(first.items.length, 5);
    assert.equal(first.items[0]?.conversation_id, recent.conversation.conversation_id,
      "Native Codex seconds must be normalized before ordering alongside agent milliseconds");
    assert.equal(first.items[0]?.updated_at, 4_000_000_000_000);
    assert.equal(first.items.find((item) => item.conversation_id === old.conversation.conversation_id)?.updated_at, 1_600_000_000_000);
    assert.equal(first.items.find((item) => item.conversation_id === root.id.toString())?.updated_at, rootTime);
    assert.equal(first.items.some((item) => item.conversation_id === hidden.id.toString()), false, "Internal conversations do not become resume candidates");
    for (const item of first.items) assert.deepEqual(await app.catalog.get(item.conversation_id), item);
    assert.equal(await app.catalog.get(hidden.id.toString()), undefined);
    assert.equal(await app.catalog.get("not-present"), undefined);
    assert.equal(first.items.find((item) => item.conversation_id === child.conversation_id)?.agent_id, child.id);
    assert.equal(first.items.find((item) => item.conversation_id === child.conversation_id)?.task_id, task.id);
    assert.equal(JSON.stringify(first).includes("TRANSCRIPT_BODY_MUST_NOT_APPEAR"), false);
    const selected = await app.catalog.list("old-source-id", null, 10);
    assert.equal(selected.items[0]?.source_thread_id, "old-source-id");
    await app.tasks.update(task.id, (saved) => {
      const agent = saved.agents.find((item) => item.id === child.id); assert.ok(agent);
      agent.updated_at = 4_100_000_000_000;
    });
    assert.equal((await app.catalog.list(task.id, null, 10)).items[0]?.conversation_id, task.conversation_id,
      "A parent's exact task ID must select that parent even when one child is newer");
    const adopted = await app.tasks.adopt(old.conversation.conversation_id, { id: "11111111-1111-4111-8111-111111111111", outcome: "Continue this existing thread", evidence: "Fixture evidence", model: fixtureModel });
    const adoptedPage = await app.catalog.list("old-source-id", null, 10);
    assert.ok(validEvent({ version: 1, id: 1, event: { type: "conversations", ...adoptedPage } }));
    assert.equal(adoptedPage.items.length, 1, "Adoption keeps one catalog row for the same native conversation");
    assert.equal(adoptedPage.items[0]?.task_id, adopted.id);
    assert.equal(adoptedPage.items[0]?.conversation_id, old.conversation.conversation_id);
    assert.equal(adoptedPage.items[0]?.source_thread_id, "old-source-id");
    assert.deepEqual(await app.catalog.get(old.conversation.conversation_id), adoptedPage.items[0]);
    app.catalog.close(); await app.session.close(BACKGROUND_CONTEXT); closed = true;
    app = await open(join(directory, "session.sqlite")); closed = false;
    const reopened = await app.catalog.list("old-source-id", null, 10);
    assert.deepEqual(reopened, adoptedPage);
    assert.equal((await app.tasks.get(task.id)).worker.state, "unassigned");
    assert.equal(app.tasks.isRunning(task.id), false);
  } finally {
    if (!closed) { app.catalog.close(); await app.session.close(BACKGROUND_CONTEXT); }
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog pages metadata once, tracks native import publications, and validates query-bound cursors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-catalog-pages-"));
  const app = await open(join(directory, "session.sqlite"));
  try {
    for (let index = 0; index < 205; index += 1) await app.histories.import(batch(`source-${index}`, `Hardware ${index}`, index));
    const expected = await app.catalog.list("hardware", null, 100), bootstrapLookups = app.histories.lookups;
    assert.ok(bootstrapLookups >= 205, "The native inventory seeds imported metadata after restart");
    const ids = expected.items.map((item) => item.conversation_id); let cursor = expected.next_cursor;
    while (cursor !== null) {
      const page = await app.catalog.list("HARDWARE", cursor, 100);
      assert.ok(page.items.length <= 100); ids.push(...page.items.map((item) => item.conversation_id)); cursor = page.next_cursor;
    }
    assert.equal(ids.length, 205); assert.equal(new Set(ids).size, 205);
    assert.equal(app.histories.lookups, bootstrapLookups, "Paging and filtering must reuse metadata instead of rescanning conversations");
    assert.equal((await app.catalog.list("source-1", null, 10)).items[0]?.source_thread_id, "source-1", "An exact source ID outranks newer partial ID matches");
    assert.equal((await app.catalog.list("not-present", null, 10)).items.length, 0);
    const added = await app.histories.import(batch("source-new", "New source title", 300));
    const lookupsAfterImport = app.histories.lookups;
    assert.equal((await app.catalog.list("source-new", null, 10)).items[0]?.conversation_id, added.conversation.conversation_id);
    await app.histories.import(batch("source-new", "Renamed at the same source clock", 300, "two"));
    assert.equal((await app.catalog.list("renamed", null, 10)).items[0]?.title, "Renamed at the same source clock");
    await app.histories.import(batch("source-new", "Stale source metadata", 200, "old"));
    assert.equal((await app.catalog.list("source-new", null, 10)).items[0]?.title, "Renamed at the same source clock");
    assert.equal(app.histories.lookups, lookupsAfterImport, "Live metadata updates must not trigger another inventory scan");
    assert.notEqual(expected.next_cursor, null);
    await assert.rejects(app.catalog.list("different query", expected.next_cursor, 100), /cursor/u);
    await assert.rejects(app.catalog.list("hardware", "not-a-cursor", 100), /cursor/u);
    await assert.rejects(app.catalog.list("", null, 101), /1 to 100/u);
  } finally { app.catalog.close(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
