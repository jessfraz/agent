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

test("canonical Pi connections apply native sync settings and retain committed entries after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-conversation-database-")), path = join(directory, "session.sqlite");
  const open = async () => {
    const database = await openConversationDatabase(path);
    try {
      const session = await Harness.open(await SqliteStorage.open(database), {
        models: createModels(), registry: createRegistry(), identity: { attribution: null },
      }, BACKGROUND_CONTEXT);
      return { database, session };
    } catch (error) { await database.close().catch(() => {}); throw error; }
  };
  let app: Awaited<ReturnType<typeof open>> | undefined;
  try {
    app = await open();
    assert.equal((await app.database.get<{ synchronous: number }>("PRAGMA synchronous"))?.synchronous, 2);
    assert.equal((await app.database.get<{ fullfsync: number }>("PRAGMA fullfsync"))?.fullfsync, 1);
    assert.equal((await app.database.get<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode, "wal");
    const conversation = await app.session.root(BACKGROUND_CONTEXT);
    const saved = await conversation.commit((tx) => tx.appendEntry(UserEntry, conversation.id, {
      model: [{ role: "user", content: "Retained connector specification", timestamp: 1 }],
    }), BACKGROUND_CONTEXT);
    await app.session.close(BACKGROUND_CONTEXT); app = undefined;
    app = await open();
    assert.equal((await app.database.get<{ synchronous: number }>("PRAGMA synchronous"))?.synchronous, 2);
    assert.equal((await app.database.get<{ fullfsync: number }>("PRAGMA fullfsync"))?.fullfsync, 1);
    const reopened = await app.session.root(BACKGROUND_CONTEXT);
    const retained = await reopened.commit((tx) => tx.entry(UserEntry, saved.id), BACKGROUND_CONTEXT);
    assert.deepEqual(retained, saved);
  } finally {
    await app?.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});
