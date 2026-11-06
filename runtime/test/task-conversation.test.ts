import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openConversationDatabase } from "../src/conversation-database.js";
import { HistoryStore } from "../src/history.js";
import { TaskStore } from "../src/tasks.js";

async function open(path: string) {
  const storage = await SqliteStorage.open(await openConversationDatabase(path));
  const session = await Harness.open(storage, { models: createModels(), registry: createRegistry(),
    identity: { attribution: null } }, BACKGROUND_CONTEXT);
  return { storage, session, tasks: new TaskStore(session) };
}

test("known conversation lookup after reopen never enumerates unrelated native histories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-conversation-")), path = join(directory, "session.sqlite");
  let app = await open(path);
  try {
    const target = await app.session.commit(async (tx) => {
      for (let index = 0; index < 1024; index += 1) await tx.createConversation({ ownership: { kind: "ownerless" } });
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const entry = await tx.appendEntry(UserEntry, conversation.id, {
        model: [{ role: "user", content: "Retained inspection output", timestamp: 1 }],
      });
      return { id: conversation.id, entry };
    }, BACKGROUND_CONTEXT);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(path);
    let enumerated = 0;
    const scan = app.storage.scanConversations.bind(app.storage);
    app.storage.scanConversations = async (...args) => {
      const page = await scan(...args); enumerated += page.items.length; return page;
    };
    const conversation = await app.tasks.conversation(target.id.toString());
    const retained = await conversation.commit((tx) => tx.entry(UserEntry, target.entry.id), BACKGROUND_CONTEXT);
    assert.equal(conversation.id, target.id); assert.deepEqual(retained, target.entry);
    assert.equal(enumerated, 0, "Opening a known conversation must not materialize the unrelated corpus");
    for (const id of ["", "0", "-1", "01", "1.0", "1e0", " 1", "unknown", String(Number.MAX_SAFE_INTEGER + 1), String(Number.MAX_SAFE_INTEGER)]) {
      await assert.rejects(app.tasks.conversation(id), /Task conversation is unavailable/);
    }
    assert.equal(enumerated, 0, "Invalid or absent identities cannot require an inventory walk");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("imported conversation identity still resolves its retained native history after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-imported-conversation-")), path = join(directory, "session.sqlite");
  let app = await open(path);
  try {
    const histories = new HistoryStore(app.session); app.tasks.useHistory(histories);
    const saved = await histories.import({ host_id: "synthetic-host", thread: {
      id: "original-source-thread", title: "Retained supplier discussion", cwd: "/workspace/example", created_at: 1, updated_at: 2,
      version: "one", version_reliable: true, archived: true, forked_from_id: null, parent_thread_id: null,
    }, items: [{ id: "original-message", turn_id: "original-turn", kind: "userMessage", role: "user", text: "Keep the connector decision",
      version: "one", order: 1, timestamp_ms: 1, data: { type: "userMessage", content: [{ type: "text", text: "Keep the connector decision" }] }, assets: [] }],
      next_cursor: null, gaps: [], complete: true });
    await app.session.close(BACKGROUND_CONTEXT); app = await open(path);
    app.tasks.useHistory(new HistoryStore(app.session));
    const conversation = await app.tasks.conversation(saved.conversation.conversation_id);
    assert.equal(conversation.id.toString(), saved.conversation.conversation_id);
    assert.match(await app.tasks.readConversation(saved.conversation.conversation_id), /Keep the connector decision/);
    await assert.rejects(app.tasks.conversation("unknown-source-thread"), /Task conversation is unavailable/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
