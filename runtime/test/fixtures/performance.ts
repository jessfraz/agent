// Native retained history only. Neither seeding nor viewing may call a provider.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { HistoryStore } from "../../src/history.js";
import type { HistoryItem } from "../../src/generated/HistoryItem.js";

globalThis.fetch = async () => { throw new Error("Performance scenarios must not contact a provider"); };

const runtime = process.env.AGENT_PERFORMANCE_RUNTIME;
if (runtime !== undefined) {
  // Runtime.start gives this process the same state argument as bridge.js.
  await import(runtime);
} else {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error("A synthetic state directory is required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  const storage = await SqliteStorage.open(database);
  const session = await Harness.open(storage, { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    for (let index = 0; index < 40; index += 1) {
      await root.submit({ type: "write", entry: { kind: "agent.performance", data: { index }, model: [{
        role: "user", content: index === 39 ? "Stored chief conversation is ready." : `Synthetic chief conversation message ${index}.`, timestamp: index,
      }] } }, BACKGROUND_CONTEXT);
    }
    const histories = new HistoryStore(session);
    const items: HistoryItem[] = Array.from({ length: 5_000 }, (_, index) => {
      const text = index === 4_999 ? "Stored long conversation is ready."
        : `Synthetic retained conversation message ${index}. A previous task has context that remains readable after its terminal closes.`;
      return { id: `message-${index}`, turn_id: `turn-${Math.floor(index / 2)}`, kind: index % 2 === 0 ? "userMessage" : "agentMessage",
        role: index % 2 === 0 ? "user" : "assistant", text, version: "v1", order: index, timestamp_ms: index,
        data: { text, phase: "final_answer" }, assets: [] };
    });
    const saved = await histories.import({ host_id: "performance-fixture", thread: { id: "long-history", title: "Synthetic long conversation",
      cwd: directory, created_at: 1, updated_at: 2, version: "v1", version_reliable: true, archived: true,
      forked_from_id: null, parent_thread_id: null }, items, next_cursor: null, gaps: [], complete: true });
    process.stdout.write(JSON.stringify({ chief: root.id.toString(), long_history: saved.conversation.conversation_id }) + "\n");
  } finally { await session.close(BACKGROUND_CONTEXT); }
}
