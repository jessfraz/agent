import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";

/** Canonical Pi commits request FULL synchronization and macOS F_FULLFSYNC. */
export async function openConversationDatabase(path: string): Promise<SqliteDatabase> {
  const database = await openNodeSqliteDatabase(path);
  try {
    await database.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON");
    return database;
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}
