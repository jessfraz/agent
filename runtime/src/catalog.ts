import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Cursor, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { SavedConversation } from "./generated/SavedConversation.js";
import type { HistoryThread } from "./generated/HistoryThread.js";
import type { TaskStore } from "./tasks.js";
import { HistoryStore, ImportedThreadEntry } from "./history.js";

type Anchor = { conversation_id: string; updated_at: number | null; exact: boolean };
type Candidate = { item: SavedConversation; exact: boolean };
function key(value: string): string { return value.normalize("NFKC").trim().toLocaleLowerCase(); }
function timestamp(value: number): number | null { return Number.isSafeInteger(value) ? value : null; }
function latest(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.max(left, right);
}
function messageTime(entry: EntryRecord): number | null {
  return entry.model?.reduce<number | null>((current, message) => latest(current, timestamp(message.timestamp)), null) ?? null;
}
function order(left: Anchor, right: Anchor): number {
  return Number(right.exact) - Number(left.exact) ||
    (right.updated_at ?? -Infinity) - (left.updated_at ?? -Infinity) || left.conversation_id.localeCompare(right.conversation_id);
}
function anchor(value: Candidate): Anchor { return { conversation_id: value.item.conversation_id, updated_at: value.item.updated_at, exact: value.exact }; }
function decode(cursor: string, query: string): Anchor {
  if (cursor.length > 4096) throw new Error("Saved conversation cursor is invalid");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new Error("Saved conversation cursor is invalid"); }
  if (typeof value !== "object" || value === null || !("query" in value) || value.query !== query ||
    !("conversation_id" in value) || typeof value.conversation_id !== "string" || value.conversation_id.length === 0 ||
    !("exact" in value) || typeof value.exact !== "boolean" || !("updated_at" in value) ||
    (value.updated_at !== null && (typeof value.updated_at !== "number" || !Number.isSafeInteger(value.updated_at)))) {
    throw new Error("Saved conversation cursor does not match this search");
  }
  return { conversation_id: value.conversation_id, updated_at: value.updated_at, exact: value.exact };
}

/** A metadata projection, seeded once through Pi and kept current by its commits. */
export class ConversationCatalog {
  private readonly imported = new Map<string, SavedConversation>();
  private root = false;
  private rootUpdatedAt: number | null = null;
  private ready = false;
  private loading: Promise<void> | undefined;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeClose: () => void;
  constructor(private readonly session: Harness, private readonly histories: HistoryStore, private readonly tasks: TaskStore) {
    this.unsubscribe = session.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === "conversation" && change.value.id === ROOT_CONVERSATION_ID) this.root = true;
        if (change.type !== "entry") continue;
        if (change.value.conversationId === ROOT_CONVERSATION_ID) {
          this.root = true; this.rootUpdatedAt = latest(this.rootUpdatedAt, messageTime(change.value));
        } else if (ImportedThreadEntry.is(change.value)) this.retain(change.value.conversationId.toString(), change.value.data.thread);
      }
    });
    this.unsubscribeClose = session.subscribeClose(() => this.close());
  }
  close(): void { this.unsubscribe(); this.unsubscribeClose(); }
  private retain(id: string, thread: HistoryThread, seeding = false): void {
    // Codex's native thread clock is seconds; native agent metadata uses milliseconds.
    const updated_at = timestamp(thread.updated_at * 1000), previous = this.imported.get(id);
    if (previous !== undefined && previous.updated_at !== null &&
      (updated_at === null || previous.updated_at > updated_at || (seeding && previous.updated_at === updated_at))) return;
    this.imported.set(id, { conversation_id: id, title: thread.title, updated_at, source_thread_id: thread.id,
      task_id: null, agent_id: null, host: null });
  }
  private async seed(): Promise<void> {
    if (this.ready) return;
    if (this.loading !== undefined) return this.loading;
    this.loading = (async () => {
      let cursor: Cursor | undefined;
      do {
        const page = await this.session.commit((tx) => tx.scanConversations({}, 100, cursor), BACKGROUND_CONTEXT);
        for (const record of page.items) {
          if (record.id === ROOT_CONVERSATION_ID) {
            this.root = true;
            const conversation = await this.session.conversation(record.id, BACKGROUND_CONTEXT);
            const tail = await conversation?.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
            for (const entry of tail?.items ?? []) this.rootUpdatedAt = latest(this.rootUpdatedAt, messageTime(entry));
          } else {
            const saved = await this.histories.byConversation(record.id.toString());
            if (saved !== undefined) this.retain(record.id.toString(), saved.thread, true);
          }
        }
        cursor = page.next;
      } while (cursor !== undefined);
      this.ready = true;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  async list(query: string, cursor: string | null, limit: number): Promise<{ items: SavedConversation[]; next_cursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 512) throw new Error("Choose 1 to 100 saved conversations and a bounded search");
    const search = key(query), after = cursor === null ? undefined : decode(cursor, search);
    await this.seed();
    const items = new Map(this.imported);
    if (this.root) items.set(ROOT_CONVERSATION_ID.toString(), { conversation_id: ROOT_CONVERSATION_ID.toString(), title: "Main agent",
      updated_at: this.rootUpdatedAt, source_thread_id: null, task_id: null, agent_id: null, host: null });
    for (const task of await this.tasks.list()) {
      for (const actor of [task, ...task.agents]) {
        const saved = items.get(actor.conversation_id);
        items.set(actor.conversation_id, { conversation_id: actor.conversation_id, title: actor.title,
          updated_at: latest(saved?.updated_at ?? null, timestamp(actor.updated_at)), source_thread_id: saved?.source_thread_id ?? null,
          task_id: task.id, agent_id: actor === task ? null : actor.id, host: actor.worker.state === "unassigned" ? null : actor.worker.host.name });
      }
    }
    const matches: Candidate[] = [];
    for (const item of items.values()) {
      const identities = [item.conversation_id, item.agent_id, item.source_thread_id,
        ...(item.agent_id === null ? [item.task_id] : [])].filter((id) => id !== null).map(key);
      const identifiers = [...identities, ...(item.task_id === null ? [] : [key(item.task_id)])];
      const exact = search.length > 0 && identities.includes(search);
      if (search.length === 0 || exact || key(item.title).includes(search) || identifiers.some((id) => id.includes(search))) matches.push({ item, exact });
    }
    matches.sort((left, right) => order(anchor(left), anchor(right)));
    const remaining = after === undefined ? matches : matches.filter((item) => order(anchor(item), after) > 0);
    const page = remaining.slice(0, limit), last = page.at(-1);
    return { items: page.map(({ item }) => ({ ...item })), next_cursor: remaining.length > limit && last !== undefined
      ? Buffer.from(JSON.stringify({ query: search, ...anchor(last) })).toString("base64url") : null };
  }
}
