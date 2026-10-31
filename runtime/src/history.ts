import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, defineEntry, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { HistoryGap } from "./generated/HistoryGap.js";
import type { HistoryAssetRef } from "./generated/HistoryAssetRef.js";
import type { HistoryImportBatch } from "./generated/HistoryImportBatch.js";
import type { HistoryImportReceipt } from "./generated/HistoryImportReceipt.js";
import type { HistoryItem } from "./generated/HistoryItem.js";
import type { HistoryRetryPage } from "./generated/HistoryRetryPage.js";
import type { HistoryThread } from "./generated/HistoryThread.js";
import type { ImportedConversation } from "./generated/ImportedConversation.js";
import type { ImportedConversationSummary } from "./generated/ImportedConversationSummary.js";
import { HistoryObservation, HistoryRevisions, REVISION_FORMAT, RevisionTracker, type CaptureState, type RevisionView, type SourceCapture, type SourceSnapshot } from "./history-revisions.js";

type InertItem = Omit<HistoryItem, "data"> & { data: JsonValue };
export const ImportedItemEntry = defineEntry<{ source: "codex"; thread_id: string; item: InertItem; observed_at?: number; snapshot?: SourceSnapshot }>("agent.history.item");
export const ImportedThreadEntry = defineEntry<{ source: "codex"; thread: HistoryThread }>("agent.history.thread");
type ThreadState = { native_id: ConversationId | null; record: ImportedConversation | null; watermark: EntryId | null; evidence: string | null; snapshot?: SourceSnapshot; capture?: CaptureState };
export type ImportCheckpoint = { version: string; next_cursor: string | null; complete: boolean; gaps: HistoryGap[]; updated_at: number;
  source_exhausted?: boolean; retry_pages?: HistoryRetryPage[]; snapshot?: SourceSnapshot; capture?: CaptureState };
const Threads = defineDocFamily<ThreadState, null>({ kind: "agent.history.threads", scope: "session", family: true, version: 1,
  initial: () => ({ native_id: null, record: null, watermark: null, evidence: null }), checkpointWhen: () => true });
const Reverse = defineDocFamily<{ thread_id: string | null }, null>({ kind: "agent.history.conversations", scope: "session", family: true, version: 1,
  initial: () => ({ thread_id: null }), checkpointWhen: () => true });
const Checkpoints = defineDocFamily<{ checkpoint: ImportCheckpoint | null; captures?: { next: number; versions: Record<string, number>; confirmed?: Record<string, string> } }, null>({ kind: "agent.history.hosts", scope: "session", family: true, version: 1,
  initial: () => ({ checkpoint: null }), checkpointWhen: () => true });
const RetainedAssets = defineDocFamily<{ assets: HistoryAssetRef[] }, null>({ kind: "agent.history.assets", scope: "session", family: true, version: 1,
  initial: () => ({ assets: [] }), checkpointWhen: () => true });
const AssetRefreshEntry = defineEntry<{ item_id: string; version: string; canonical_version?: string }>("agent.history.asset-refresh");
export function isHistoryEntry(entry: EntryRecord): boolean {
  return ImportedItemEntry.is(entry) || ImportedThreadEntry.is(entry) || AssetRefreshEntry.is(entry) || HistoryObservation.is(entry);
}
type Cache = { native_id: ConversationId | null; watermark: EntryId | null; receipts: Set<string>;
  canonical: Map<string, string>; items: Map<string, Set<EntryId>>; entries: Map<string, EntryId>; revisions: RevisionTracker };
export class HistoryError extends Error {}
class OriginalUnavailable extends HistoryError {}
function identity(...values: string[]): string { return createHash("sha256").update(JSON.stringify(["codex", ...values])).digest("hex"); }
function receipt(item: HistoryItem): string { return JSON.stringify(["item", item.id, item.version]); }
function captureOrder(previous: SourceSnapshot | undefined, state: CaptureState | undefined, incoming: SourceCapture | undefined): "older" | "own_provisional" | "comparable" | "unknown" {
  if (previous === undefined || incoming === undefined || previous.host_id !== incoming.snapshot.host_id) return "unknown";
  if (state !== undefined && (incoming.attempt < state.attempt ||
    (incoming.attempt === state.attempt && incoming.phase === "advertised" && state.phase === "read"))) return "older";
  if (state?.phase === "advertised" && state.attempt === incoming.attempt && incoming.phase === "read") return "own_provisional";
  return incoming.snapshot.sequence < previous.sequence ? "older" : "comparable";
}
function sameContext(left: InertItem, right: InertItem): boolean {
  return left.id === right.id && left.turn_id === right.turn_id && left.kind === right.kind && left.role === right.role &&
    left.order === right.order && left.timestamp_ms === right.timestamp_ms;
}
function mergeAssets(left: readonly HistoryAssetRef[], right: readonly HistoryAssetRef[]): HistoryAssetRef[] {
  return [...new Map([...left, ...right].map((asset) => [JSON.stringify([asset.kind, asset.path]), asset])).values()];
}
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
export function importedSummary(record: ImportedConversation): ImportedConversationSummary {
  return { source: record.source, thread: { ...record.thread }, conversation_id: record.conversation_id,
    adopted_task_id: record.adopted_task_id, complete: record.complete, gap_count: record.gaps.length,
    gaps: record.gaps.slice(0, 3).map((gap) => {
      const text = Array.from(gap.message);
      return { ...gap, message: text.length <= 320 ? gap.message : text.slice(0, 319).join("") + "…" };
    }) };
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
    return state?.checkpoint === null || state?.checkpoint === undefined ? undefined : structuredClone(state.checkpoint);
  }
  /** Claim capture order before a source RPC; known snapshot replays keep their epoch. */
  async capture(hostId: string, thread: HistoryThread, freshAttempt = false): Promise<SourceCapture | undefined> {
    if (!thread.version_reliable) return undefined;
    return this.session.commit(async (tx) => {
      const state = await tx.doc(Checkpoints, identity(thread.id, hostId), null);
      if (state.captures === undefined) state.captures = { next: 0, versions: {} };
      const clock = state.captures, key = identity("snapshot", thread.version);
      const known = clock.versions[key];
      if (!freshAttempt && known !== undefined) return { thread_id: thread.id, attempt: known, phase: "advertised",
        snapshot: { host_id: hostId, version: thread.version, sequence: known } };
      if (!Number.isSafeInteger(clock.next) || clock.next >= Number.MAX_SAFE_INTEGER) throw new HistoryError("History capture sequence is unavailable");
      const attempt = ++clock.next, sequence = known ?? attempt; clock.versions[key] = sequence;
      return { thread_id: thread.id, attempt, phase: "advertised", snapshot: { host_id: hostId, version: thread.version, sequence } };
    }, BACKGROUND_CONTEXT);
  }
  /** A first page can reveal a newer native fingerprint than its inventory did. */
  async rebindCapture(capture: SourceCapture | null, thread: HistoryThread): Promise<SourceCapture | null> {
    if (capture === null || !thread.version_reliable) return null;
    if (capture.thread_id !== thread.id) throw new HistoryError("History capture belongs to another thread");
    if (capture.phase === "read") return capture.snapshot.version === thread.version ? capture : null;
    return this.session.commit(async (tx) => {
      const state = await tx.doc(Checkpoints, identity(thread.id, capture.snapshot.host_id), null), clock = state.captures;
      if (clock === undefined || capture.attempt > clock.next) throw new HistoryError("History capture is unavailable");
      const confirmation = clock.confirmed?.[capture.attempt.toString()];
      if (confirmation !== undefined && confirmation !== thread.version) return null;
      const key = identity("snapshot", thread.version), known = clock.versions[key];
      // An overlapping later capture makes an unadvertised version's order
      // unknowable. Retain the page without inventing a host epoch for it.
      if (known === undefined && capture.attempt < clock.next) return null;
      const sequence = known ?? capture.attempt;
      clock.versions[key] = sequence;
      if (clock.confirmed === undefined) clock.confirmed = {};
      clock.confirmed[capture.attempt.toString()] = thread.version;
      return { ...capture, phase: "read", snapshot: { ...capture.snapshot, version: thread.version, sequence } };
    }, BACKGROUND_CONTEXT);
  }
  /** Bounded read. Legacy ledgers reconcile under the existing index owner. */
  async revisionView(threadId: string): Promise<RevisionView> {
    // Imports publish this certificate in the same commit as their source rows.
    // Its cutoff also excludes a later concurrent import from this read snapshot.
    const projection = await this.session.snapshot(HistoryRevisions, identity(threadId), BACKGROUND_CONTEXT);
    return { watermark: projection?.watermark ?? null, ready: projection?.format === REVISION_FORMAT && projection.watermark !== null,
      entries: projection?.entries ?? {} };
  }
  async prepareRevisions(conversationId: string): Promise<void> {
    const link = await this.session.snapshot(Reverse, conversationId, BACKGROUND_CONTEXT);
    if (link?.thread_id === undefined || link.thread_id === null) return;
    const key = identity(link.thread_id);
    while (true) {
      const state = await this.session.snapshot(Threads, key, BACKGROUND_CONTEXT);
      if (state?.native_id === undefined || state.native_id === null) return;
      const projection = await this.session.snapshot(HistoryRevisions, key, BACKGROUND_CONTEXT);
      if (projection?.format === REVISION_FORMAT && projection.watermark === state.watermark) return;
      const cache = await this.cache(link.thread_id, state), entries = cache.revisions.projection();
      if (await this.session.commit(async (tx) => {
        const current = await tx.doc(Threads, key, null);
        if (current.native_id !== state.native_id || current.watermark !== state.watermark) return false;
        const view = await tx.doc(HistoryRevisions, key, null); view.watermark = state.watermark; view.entries = entries; view.format = REVISION_FORMAT; return true;
      }, BACKGROUND_CONTEXT)) return;
    }
  }
  /** Older native listings omitted lineage even when a read supplied the current version. */
  async reconcileLineage(thread: HistoryThread): Promise<void> {
    if (!thread.version_reliable) return;
    const key = identity(thread.id), before = await this.session.snapshot(Threads, key, BACKGROUND_CONTEXT);
    const previous = before?.record?.thread;
    if (before?.native_id === null || before?.native_id === undefined || previous === undefined ||
      !previous.version_reliable || previous.version !== thread.version || previous.updated_at > thread.updated_at ||
      (previous.parent_thread_id === thread.parent_thread_id && previous.forked_from_id === thread.forked_from_id)) return;
    await this.session.commit(async (tx) => {
      const current = await tx.doc(Threads, key, null), saved = current.record?.thread;
      if (current.native_id !== before.native_id || saved === undefined || !saved.version_reliable ||
        saved.version !== thread.version || saved.updated_at > thread.updated_at) return;
      // Keep the current record's coverage and adoption; lineage does not change indexed text.
      saved.parent_thread_id = thread.parent_thread_id; saved.forked_from_id = thread.forked_from_id;
    }, BACKGROUND_CONTEXT);
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
    return ImportedItemEntry.is(entry) ? { ...entry, data: { ...entry.data, item: { ...entry.data.item, assets: await this.retainedAssets(entry) } } } : entry;
  }
  private async retainedAssets(entry: EntryRecord): Promise<HistoryAssetRef[]> {
    if (!ImportedItemEntry.is(entry)) return [];
    const { thread_id, item } = entry.data;
    const retained = await this.session.snapshot(RetainedAssets, identity(thread_id, item.id, item.version), BACKGROUND_CONTEXT);
    return mergeAssets(item.assets, retained?.assets ?? []);
  }
  async indexText(entry: EntryRecord): Promise<string | undefined> {
    if (!ImportedItemEntry.is(entry)) return importedText(entry);
    const item = entry.data.item;
    if (item.kind === "imageGeneration") return "";
    if (item.role !== "user" && item.role !== "assistant") return item.text.slice(0, 32_000);
    try { return body(await this.original(entry)) || item.text; }
    catch (error) {
      if (error instanceof OriginalUnavailable) return "Bounded historical excerpt (full original unavailable):\n" + item.text;
      throw error;
    }
  }
  async original(entry: EntryRecord): Promise<JsonValue> {
    if (!ImportedItemEntry.is(entry)) throw new HistoryError("This is not imported source evidence");
    return this.originalItem(entry.data.item, entry.data.item.data === null ? await this.retainedAssets(entry) : []);
  }
  private async originalItem(item: InertItem, assets: readonly HistoryAssetRef[]): Promise<JsonValue> {
    let data = item.data;
    if (data === null) {
      const cold = assets.find((asset) => asset.kind === "cold_evidence");
      if (cold === undefined) throw new OriginalUnavailable("Full historical original is unavailable; only its bounded saved excerpt is retained");
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
    const receipts = new Set(current?.receipts), canonical = new Map(current?.canonical), items = new Map<string, Set<EntryId>>();
    const entries = new Map(current?.entries), revisions = current?.revisions ?? new RevisionTracker();
    for (const [id, entries] of current?.items ?? []) items.set(id, new Set(entries));
    if (native_id !== null) {
      const conversation = await this.session.conversation(native_id, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new HistoryError("Imported conversation is unavailable");
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({ order: "ascending", ...(current?.watermark === null || current?.watermark === undefined ? {} : { minEntryId: current.watermark }) }, 100, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) {
          if (ImportedItemEntry.is(entry)) {
            const key = receipt(entry.data.item); receipts.add(key); canonical.set(key, entry.data.item.version);
            entries.set(key, entry.id); revisions.add(entry.id, entry.data.item, entry.data.observed_at, entry.data.snapshot);
            const known = items.get(entry.data.item.id) ?? new Set<EntryId>(); known.add(entry.id); items.set(entry.data.item.id, known);
          }
          else if (ImportedThreadEntry.is(entry)) { receipts.add(JSON.stringify(["thread", entry.data.thread.version])); revisions.metadata(entry.data.thread.updated_at); }
          else if (HistoryObservation.is(entry)) revisions.observe(entry.data.entry_ids, entry.data.updated_at, entry.data.snapshot);
          else if (AssetRefreshEntry.is(entry) && entry.data.canonical_version !== undefined) {
            const key = JSON.stringify(["item", entry.data.item_id, entry.data.version]);
            receipts.add(key); canonical.set(key, entry.data.canonical_version);
          }
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }
    const cache = { native_id, watermark, receipts, canonical, items, entries, revisions }; this.cached = { thread_id: threadId, cache }; return cache;
  }
  private async aliases(items: InertItem[], cache: Cache): Promise<Map<string, string>> {
    const aliases = new Map<string, string>(), prepared = new Map<string, { item: InertItem; canonical: string }[]>(), seen = new Set<string>();
    for (const item of items) {
      const key = receipt(item);
      if (cache.receipts.has(key) || seen.has(key)) continue;
      seen.add(key);
      const known = cache.items.get(item.id), pending = prepared.get(item.id) ?? [];
      if ((known?.size ?? 0) > 0 || pending.length > 0) {
        try {
          const original = await this.originalItem(item, item.assets), matches = new Set<string>(); let uncertain = false;
          for (const id of known ?? []) {
            const entry = await this.session.commit((tx) => tx.entry(id), BACKGROUND_CONTEXT);
            if (!ImportedItemEntry.is(entry) || !sameContext(entry.data.item, item)) continue;
            try { if (isDeepStrictEqual(await this.original(entry), original)) matches.add(entry.data.item.version); }
            catch { uncertain = true; }
          }
          for (const previous of pending) if (sameContext(previous.item, item) &&
            isDeepStrictEqual(await this.originalItem(previous.item, previous.item.assets), original)) matches.add(previous.canonical);
          if (!uncertain && matches.size === 1) for (const version of matches) aliases.set(receipt(item), version);
        } catch { /* Preserve a distinct version when its full payload cannot be compared. */ }
      }
      pending.push({ item, canonical: aliases.get(receipt(item)) ?? item.version }); prepared.set(item.id, pending);
    }
    return aliases;
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
  async import(batch: HistoryImportBatch, captured?: SourceCapture | null): Promise<HistoryImportReceipt> {
    if (batch.thread.id.length === 0 || batch.thread.version.length === 0 || batch.host_id.length === 0) throw new HistoryError("History source identity is required");
    if (batch.complete && batch.next_cursor !== null) throw new HistoryError("Complete history cannot have an unread continuation");
    const items: InertItem[] = batch.items.map((item) => {
      if (item.id.length === 0 || item.version.length === 0 || !json(item.data)) throw new HistoryError("History item identity and JSON evidence are required");
      return { ...item, data: item.data };
    });
    let capture = captured === undefined ? await this.capture(batch.host_id, batch.thread) : captured ?? undefined;
    if (capture?.phase === "advertised" && (batch.items.length > 0 || batch.complete)) capture = await this.rebindCapture(capture, batch.thread) ?? undefined;
    const snapshot = capture?.snapshot;
    if (capture !== undefined && (capture.thread_id !== batch.thread.id || snapshot?.host_id !== batch.host_id || snapshot.version !== batch.thread.version)) {
      throw new HistoryError("History capture does not match this source page");
    }
    await this.assets(items);
    const key = identity(batch.thread.id);
    while (true) {
      const before = await this.session.snapshot(Threads, key, BACKGROUND_CONTEXT);
      const cache = await this.cache(batch.thread.id, before);
      const expectedNative = cache.native_id, expectedWatermark = cache.watermark;
      const aliases = await this.aliases(items, cache);
      const result = await this.session.commit(async (tx) => {
        const state = await tx.doc(Threads, key, null);
        if (state.native_id !== expectedNative || state.watermark !== expectedWatermark) return undefined;
        const host = await tx.doc(Checkpoints, identity(batch.thread.id, batch.host_id), null);
        if (snapshot !== undefined && host.captures?.versions[identity("snapshot", snapshot.version)] !== snapshot.sequence) throw new HistoryError("History capture is unavailable");
        const native = state.native_id ?? (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
        state.native_id = native;
        const reverse = await tx.doc(Reverse, native.toString(), null); reverse.thread_id = batch.thread.id;
        const added: string[] = []; const keys: string[] = []; const canonical = new Map<string, string>();
        const appended: { id: string; entry: EntryId; item: InertItem }[] = [], observed: EntryId[] = [], incoming = new Map<string, EntryId>();
        let addedItems = 0; let existingItems = 0;
        const metadataKey = JSON.stringify(["thread", batch.thread.version]);
        if (!cache.receipts.has(metadataKey)) {
          const entry = await tx.appendEntry(ImportedThreadEntry, native, { data: { source: "codex", thread: batch.thread } });
          state.watermark = entry.id; added.push(entry.id.toString()); keys.push(metadataKey);
        }
        const seen = new Set(cache.receipts);
        for (const item of items) {
          const itemKey = receipt(item);
          const alias = aliases.get(itemKey);
          if (seen.has(itemKey) || alias !== undefined) {
            existingItems += 1;
            const version = canonical.get(itemKey) ?? cache.canonical.get(itemKey) ?? alias ?? item.version;
            const original = receipt({ ...item, version });
            const nativeEntry = incoming.get(original) ?? cache.entries.get(original);
            if (nativeEntry !== undefined) observed.push(nativeEntry);
            let changed = !seen.has(itemKey);
            if (item.assets.length > 0) {
              const refs = await tx.doc(RetainedAssets, identity(batch.thread.id, item.id, version), null);
              const assets = mergeAssets(refs.assets, item.assets);
              if (JSON.stringify(assets) !== JSON.stringify(refs.assets)) {
                refs.assets = assets; changed = true;
              }
            }
            if (changed) {
              // Evidence aliases and asset recovery change searchable originals,
              // never immutable messages. Retain the real source version.
              const refreshed = await tx.appendEntry(AssetRefreshEntry, native, { data: { item_id: item.id, version: item.version,
                ...(version === item.version ? {} : { canonical_version: version }) } });
              state.watermark = refreshed.id; added.push(refreshed.id.toString());
            }
            if (!seen.has(itemKey)) { keys.push(itemKey); seen.add(itemKey); canonical.set(itemKey, version); }
            continue;
          }
          const entry = await tx.appendEntry(ImportedItemEntry, native, { data: { source: "codex", thread_id: batch.thread.id, item,
            ...(Number.isSafeInteger(batch.thread.updated_at) ? { observed_at: batch.thread.updated_at } : {}), ...(snapshot === undefined ? {} : { snapshot }) } });
          if (item.assets.length > 0) {
            const refs = await tx.doc(RetainedAssets, identity(batch.thread.id, item.id, item.version), null);
            refs.assets = mergeAssets(refs.assets, item.assets);
          }
          state.watermark = entry.id; added.push(entry.id.toString()); keys.push(itemKey); seen.add(itemKey); addedItems += 1;
          canonical.set(itemKey, item.version); incoming.set(itemKey, entry.id); appended.push({ id: item.id, entry: entry.id, item });
        }
        const plan = cache.revisions.plan(appended.map((item) => ({ id: item.entry, item: item.item })), observed, batch.thread.updated_at, snapshot);
        if (plan.observations.length > 0) {
          const observation = await tx.appendEntry(HistoryObservation, native, { data: { updated_at: batch.thread.updated_at, entry_ids: plan.observations,
            ...(snapshot === undefined ? {} : { snapshot }) } });
          state.watermark = observation.id; added.push(observation.id.toString());
        }
        const view = await tx.doc(HistoryRevisions, key, null);
        const entries = view.format === REVISION_FORMAT && view.watermark === expectedWatermark ? { ...view.entries } : cache.revisions.projection();
        for (const [id, status] of plan.changes) { if (status === undefined) delete entries[id]; else entries[id] = status; }
        view.entries = entries; view.watermark = state.watermark; view.format = REVISION_FORMAT;
        const previous = state.record;
        const sameVersion = previous?.thread.version === batch.thread.version;
        // Native updated_at can be second-granular. A changed locator fingerprint
        // still owns a new checkpoint, including its unfinished continuation.
        const olderCapture = captureOrder(state.snapshot, state.capture, capture) === "older";
        const unknownCapture = snapshot === undefined && state.snapshot !== undefined && !sameVersion;
        const newer = previous === null || batch.thread.updated_at > previous.thread.updated_at ||
          (batch.thread.updated_at === previous.thread.updated_at && !olderCapture && !unknownCapture);
        if (newer) {
          const complete = (sameVersion && batch.thread.version_reliable && previous?.thread.version_reliable && previous.complete) ||
            (batch.complete && batch.gaps.length === 0);
          state.record = { source: "codex", thread: batch.thread, conversation_id: native.toString(), adopted_task_id: previous?.adopted_task_id ?? null,
            complete, gaps: complete ? [] : batch.retry_pages === undefined ? gaps(sameVersion ? previous?.gaps ?? [] : [], batch.gaps) : structuredClone(batch.gaps) };
          if (snapshot === undefined) delete state.snapshot; else state.snapshot = snapshot;
          if (capture === undefined) delete state.capture; else state.capture = { attempt: capture.attempt, phase: capture.phase };
        }
        const checkpoint = host.checkpoint;
        const olderCheckpoint = captureOrder(checkpoint?.snapshot, checkpoint?.capture, capture) === "older";
        const unknownCheckpoint = snapshot === undefined && checkpoint?.snapshot !== undefined && checkpoint.version !== batch.thread.version;
        if (checkpoint === null || batch.thread.updated_at > checkpoint.updated_at || (batch.thread.updated_at === checkpoint.updated_at && !olderCheckpoint && !unknownCheckpoint)) {
          if (!(batch.thread.version_reliable && checkpoint?.version === batch.thread.version && checkpoint.complete && !batch.complete)) {
            host.checkpoint = { version: batch.thread.version, next_cursor: batch.next_cursor, complete: batch.complete && batch.gaps.length === 0,
              gaps: batch.complete || batch.retry_pages !== undefined ? structuredClone(batch.gaps) : gaps(checkpoint?.version === batch.thread.version ? checkpoint.gaps : [], batch.gaps), updated_at: batch.thread.updated_at,
              ...(batch.source_exhausted === undefined ? {} : { source_exhausted: batch.source_exhausted }),
              ...(batch.retry_pages === undefined ? {} : { retry_pages: structuredClone(batch.retry_pages) }) };
            if (snapshot !== undefined) host.checkpoint.snapshot = snapshot;
            if (capture !== undefined) host.checkpoint.capture = { attempt: capture.attempt, phase: capture.phase };
          }
        }
        return { native, watermark: state.watermark, added, keys, addedItems, existingItems, canonical, appended, plan };
      }, BACKGROUND_CONTEXT);
      if (result === undefined) continue;
      for (const key of result.keys) cache.receipts.add(key);
      for (const [key, version] of result.canonical) cache.canonical.set(key, version);
      for (const item of result.appended) {
        const known = cache.items.get(item.id) ?? new Set<EntryId>(); known.add(item.entry); cache.items.set(item.id, known);
        cache.entries.set(receipt(item.item), item.entry);
      }
      cache.revisions.apply(result.plan); cache.revisions.metadata(batch.thread.updated_at);
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
