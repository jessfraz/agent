import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, defineEntry, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { HistoryGap } from "./generated/HistoryGap.js";
import type { HistoryImportBatch } from "./generated/HistoryImportBatch.js";
import type { HistoryImportReceipt } from "./generated/HistoryImportReceipt.js";
import type { HistoryItem } from "./generated/HistoryItem.js";
import type { HistoryThread } from "./generated/HistoryThread.js";
import type { ImportedConversation } from "./generated/ImportedConversation.js";

type InertItem = Omit<HistoryItem, "data"> & { data: JsonValue };
export const ImportedItemEntry = defineEntry<{ source: "codex"; thread_id: string; item: InertItem }>("agent.history.item");
export const ImportedThreadEntry = defineEntry<{ source: "codex"; thread: HistoryThread }>("agent.history.thread");
type ThreadState = { native_id: ConversationId | null; record: ImportedConversation | null; watermark: EntryId | null; evidence: string | null };
export type ImportCheckpoint = { version: string; next_cursor: string | null; complete: boolean; gaps: HistoryGap[]; updated_at: number };
const Threads = defineDocFamily<ThreadState, null>({ kind: "agent.history.threads", scope: "session", family: true, version: 1,
  initial: () => ({ native_id: null, record: null, watermark: null, evidence: null }), checkpointWhen: () => true });
const Reverse = defineDocFamily<{ thread_id: string | null }, null>({ kind: "agent.history.conversations", scope: "session", family: true, version: 1,
  initial: () => ({ thread_id: null }), checkpointWhen: () => true });
const Checkpoints = defineDocFamily<{ checkpoint: ImportCheckpoint | null }, null>({ kind: "agent.history.hosts", scope: "session", family: true, version: 1,
  initial: () => ({ checkpoint: null }), checkpointWhen: () => true });
type Cache = { native_id: ConversationId | null; watermark: EntryId | null; receipts: Set<string> };
export class HistoryError extends Error {}
function identity(...values: string[]): string { return createHash("sha256").update(JSON.stringify(["codex", ...values])).digest("hex"); }
function receipt(item: HistoryItem): string { return JSON.stringify(["item", item.id, item.version]); }
function json(value: unknown): value is JsonValue {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) ? value.every(json)
      : typeof value === "object" && value !== null && Object.values(value).every(json));
}
function gaps(left: readonly HistoryGap[], right: readonly HistoryGap[]): HistoryGap[] {
  const known = new Map([...left, ...right].map((gap) => [JSON.stringify(gap), gap]));
  return [...known.values()].map((gap) => ({ ...gap }));
}
function title(text: string): string { return Array.from(text.replace(/\s+/gu, " ").trim()).slice(0, 128).join(""); }
function detached(record: ImportedConversation): ImportedConversation {
  return { ...record, thread: { ...record.thread, title: title(record.thread.title) }, gaps: record.gaps.map((gap) => ({ ...gap })) };
}
function body(data: JsonValue): string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "";
  const text: string[] = [];
  for (const name of ["text", "review"]) { const value = data[name]; if (typeof value === "string") text.push(value); }
  for (const name of ["content", "contentItems", "summary"]) {
    const values = data[name];
    if (Array.isArray(values)) for (const value of values) {
      if (typeof value === "string") text.push(value);
      else if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.text === "string") text.push(value.text);
    }
  }
  return text.join("\n");
}
function entryIdentity(value: unknown): value is EntryId { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function importedText(entry: EntryRecord): string | undefined {
  if (ImportedItemEntry.is(entry)) return entry.data.item.text;
  if (ImportedThreadEntry.is(entry)) return title(entry.data.thread.title);
  return undefined;
}

/** Native data entries are the item/version ledger; no submissions or executions. */
export class HistoryStore {
  private cached: { thread_id: string; cache: Cache } | undefined;
  constructor(readonly session: Harness, private readonly assetRoot?: string) {}
  async get(threadId: string): Promise<ImportedConversation | undefined> {
    const state = await this.session.snapshot(Threads, identity(threadId), BACKGROUND_CONTEXT);
    return state?.record === null || state?.record === undefined ? undefined : detached(state.record);
  }
  async byConversation(id: string): Promise<ImportedConversation | undefined> {
    const link = await this.session.snapshot(Reverse, id, BACKGROUND_CONTEXT);
    return link?.thread_id === null || link?.thread_id === undefined ? undefined : this.get(link.thread_id);
  }
  async checkpoint(threadId: string, hostId: string): Promise<ImportCheckpoint | undefined> {
    const state = await this.session.snapshot(Checkpoints, identity(threadId, hostId), BACKGROUND_CONTEXT);
    return state?.checkpoint === null || state?.checkpoint === undefined ? undefined : { ...state.checkpoint, gaps: state.checkpoint.gaps.map((gap) => ({ ...gap })) };
  }
  async conversation(id: string): Promise<Conversation | undefined> {
    const link = await this.session.snapshot(Reverse, id, BACKGROUND_CONTEXT);
    if (link?.thread_id === null || link?.thread_id === undefined) return undefined;
    const state = await this.session.snapshot(Threads, identity(link.thread_id), BACKGROUND_CONTEXT);
    return state?.native_id === null || state?.native_id === undefined ? undefined : this.session.conversation(state.native_id, BACKGROUND_CONTEXT);
  }
  async entry(conversationId: string, id: string): Promise<EntryRecord> {
    const native: unknown = Number(id);
    if (!entryIdentity(native) || native.toString() !== id) throw new HistoryError("Invalid native entry ID");
    const entry = await this.session.commit((tx) => tx.entry(native), BACKGROUND_CONTEXT);
    if (entry === undefined || entry.conversationId.toString() !== conversationId) throw new HistoryError("Entry does not belong to this conversation");
    return entry;
  }
  async indexText(entry: EntryRecord): Promise<string | undefined> {
    if (!ImportedItemEntry.is(entry)) return importedText(entry);
    const item = entry.data.item;
    if (item.role !== "user" && item.role !== "assistant") return item.text.slice(0, 32_000);
    const data = await this.original(entry);
    return body(data) || item.text;
  }
  async original(entry: EntryRecord): Promise<JsonValue> {
    if (!ImportedItemEntry.is(entry)) throw new HistoryError("This is not imported source evidence");
    const item = entry.data.item; let data = item.data;
    const cold = item.assets.find((asset) => asset.kind === "cold_evidence");
    if (data === null && cold !== undefined) {
      if (cold.size === null || cold.size > 64 * 1024 * 1024) throw new HistoryError("Historical text exceeds the bounded index reader; source evidence is retained");
      const bytes = await readFile(cold.path);
      if (createHash("sha256").update(bytes).digest("hex") !== cold.sha256) throw new HistoryError("Retained history evidence changed");
      const decoded: unknown = JSON.parse(bytes.toString("utf8"));
      if (!json(decoded)) throw new HistoryError("Retained history evidence is invalid JSON"); data = decoded;
    }
    return data;
  }
  private async cache(threadId: string, state: Readonly<ThreadState> | undefined): Promise<Cache> {
    const native_id = state?.native_id ?? null; const watermark = state?.watermark ?? null;
    const current = this.cached?.thread_id === threadId && this.cached.cache.native_id === native_id ? this.cached.cache : undefined;
    if (current !== undefined && current.watermark === watermark) return current;
    const receipts = new Set(current?.receipts);
    if (native_id !== null) {
      const conversation = await this.session.conversation(native_id, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new HistoryError("Imported conversation is unavailable");
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({ order: "ascending", ...(current?.watermark === null || current?.watermark === undefined ? {} : { minEntryId: current.watermark }) }, 100, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) {
          if (ImportedItemEntry.is(entry)) receipts.add(receipt(entry.data.item));
          else if (ImportedThreadEntry.is(entry)) receipts.add(JSON.stringify(["thread", entry.data.thread.version]));
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }
    const cache = { native_id, watermark, receipts }; this.cached = { thread_id: threadId, cache }; return cache;
  }
  private async assets(items: readonly HistoryItem[]): Promise<void> {
    const assets = items.flatMap((item) => item.assets);
    if (assets.length === 0) return;
    if (this.assetRoot === undefined) throw new HistoryError("History assets require coordinator-owned storage");
    const root = await realpath(this.assetRoot); const verified = new Set<string>();
    for (const asset of assets) {
      if (asset.sha256 === null || !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.size === null || !isAbsolute(asset.path)) throw new HistoryError("History asset has not been retained on the coordinator");
      if (verified.has(asset.path)) continue;
      const path = await realpath(asset.path); const child = relative(root, path);
      if (child === "" || child === ".." || child.startsWith(".." + sep) || isAbsolute(child)) throw new HistoryError("History asset is outside coordinator storage");
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size !== asset.size) throw new HistoryError("Retained history asset changed");
      verified.add(asset.path);
    }
  }
  async import(batch: HistoryImportBatch): Promise<HistoryImportReceipt> {
    if (batch.thread.id.length === 0 || batch.thread.version.length === 0 || batch.host_id.length === 0) throw new HistoryError("History source identity is required");
    if (batch.complete && batch.next_cursor !== null) throw new HistoryError("Complete history cannot have an unread continuation");
    const items: InertItem[] = batch.items.map((item) => {
      if (item.id.length === 0 || item.version.length === 0 || !json(item.data)) throw new HistoryError("History item identity and JSON evidence are required");
      return { ...item, data: item.data };
    });
    await this.assets(items);
    const key = identity(batch.thread.id);
    while (true) {
      const before = await this.session.snapshot(Threads, key, BACKGROUND_CONTEXT);
      const cache = await this.cache(batch.thread.id, before);
      const result = await this.session.commit(async (tx) => {
        const state = await tx.doc(Threads, key, null);
        if (state.native_id !== cache.native_id || state.watermark !== cache.watermark) return undefined;
        const host = await tx.doc(Checkpoints, identity(batch.thread.id, batch.host_id), null);
        const native = state.native_id ?? (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
        state.native_id = native;
        const reverse = await tx.doc(Reverse, native.toString(), null); reverse.thread_id = batch.thread.id;
        const added: string[] = []; const keys: string[] = []; let addedItems = 0; let existingItems = 0;
        const metadataKey = JSON.stringify(["thread", batch.thread.version]);
        if (!cache.receipts.has(metadataKey)) {
          const entry = await tx.appendEntry(ImportedThreadEntry, native, { data: { source: "codex", thread: batch.thread } });
          state.watermark = entry.id; added.push(entry.id.toString()); keys.push(metadataKey);
        }
        const seen = new Set(cache.receipts);
        for (const item of items) {
          const itemKey = receipt(item);
          if (seen.has(itemKey)) { existingItems += 1; continue; }
          const entry = await tx.appendEntry(ImportedItemEntry, native, { data: { source: "codex", thread_id: batch.thread.id, item } });
          state.watermark = entry.id; added.push(entry.id.toString()); keys.push(itemKey); seen.add(itemKey); addedItems += 1;
        }
        const previous = state.record;
        const sameVersion = previous?.thread.version === batch.thread.version;
        // Native updated_at can be second-granular. A changed locator fingerprint
        // still owns a new checkpoint, including its unfinished continuation.
        const newer = previous === null || batch.thread.updated_at >= previous.thread.updated_at;
        if (newer) {
          const complete = (sameVersion && batch.thread.version_reliable && previous?.thread.version_reliable && previous.complete) ||
            (batch.complete && batch.gaps.length === 0);
          state.record = { source: "codex", thread: batch.thread, conversation_id: native.toString(), adopted_task_id: previous?.adopted_task_id ?? null,
            complete, gaps: complete ? [] : gaps(sameVersion ? previous?.gaps ?? [] : [], batch.gaps) };
        }
        const checkpoint = host.checkpoint;
        if (checkpoint === null || batch.thread.updated_at >= checkpoint.updated_at) {
          if (!(batch.thread.version_reliable && checkpoint?.version === batch.thread.version && checkpoint.complete && !batch.complete)) {
            host.checkpoint = { version: batch.thread.version, next_cursor: batch.next_cursor, complete: batch.complete && batch.gaps.length === 0,
              gaps: batch.complete ? batch.gaps : gaps(checkpoint?.version === batch.thread.version ? checkpoint.gaps : [], batch.gaps), updated_at: batch.thread.updated_at };
          }
        }
        return { native, watermark: state.watermark, added, keys, addedItems, existingItems };
      }, BACKGROUND_CONTEXT);
      if (result === undefined) continue;
      for (const key of result.keys) cache.receipts.add(key);
      cache.native_id = result.native; cache.watermark = result.watermark; this.cached = { thread_id: batch.thread.id, cache };
      const conversation = await this.get(batch.thread.id);
      if (conversation === undefined) throw new HistoryError("History mapping did not commit");
      return { conversation, added_items: result.addedItems, existing_items: result.existingItems, entry_ids: result.added, watermark: result.watermark?.toString() ?? null };
    }
  }
  async adopt(threadId: string, taskId: string, evidence: string, create: (tx: Tx, native: ConversationId, record: ImportedConversation) => Promise<void>): Promise<string> {
    return this.session.commit(async (tx) => {
      const state = await tx.doc(Threads, identity(threadId), null);
      if (state.record === null || state.native_id === null) throw new HistoryError("Unknown imported conversation");
      if (state.record.adopted_task_id !== null) return state.record.adopted_task_id;
      await create(tx, state.native_id, detached(state.record));
      state.record.adopted_task_id = taskId; state.evidence = evidence.slice(0, 24_000);
      return taskId;
    }, BACKGROUND_CONTEXT);
  }
  async evidence(conversationId: string): Promise<string> {
    const link = await this.session.snapshot(Reverse, conversationId, BACKGROUND_CONTEXT);
    if (link?.thread_id === null || link?.thread_id === undefined) return "";
    const state = await this.session.snapshot(Threads, identity(link.thread_id), BACKGROUND_CONTEXT);
    return state?.evidence ?? "";
  }
  async *inventory(): AsyncIterable<{ conversation_id: string; watermark: string }> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.session.commit((tx) => tx.scanConversations({}, 100, cursor), BACKGROUND_CONTEXT);
      for (const record of page.items) {
        const conversation = await this.session.conversation(record.id, BACKGROUND_CONTEXT);
        if (conversation === undefined) continue;
        const tail = await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
        yield { conversation_id: record.id.toString(), watermark: tail.items[0]?.id.toString() ?? "empty" };
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
}
