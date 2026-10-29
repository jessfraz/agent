import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { AgentNode } from "./generated/AgentNode.js";
import type { HistoryAssetRef } from "./generated/HistoryAssetRef.js";
import type { HistoryGap } from "./generated/HistoryGap.js";
import type { HistoryItem } from "./generated/HistoryItem.js";
import type { HistoryRequest } from "./generated/HistoryRequest.js";
import type { HistoryResponse } from "./generated/HistoryResponse.js";
import type { HistoryRetryPage } from "./generated/HistoryRetryPage.js";
import type { HistoryThread } from "./generated/HistoryThread.js";
import type { ImportProgress } from "./generated/ImportProgress.js";
import type { HostCall } from "./tasks.js";
import type { HistoryStore, ImportCheckpoint } from "./history.js";

// Keep source progress separate from index errors so retries need no native walk.
const Progress = defineDoc<{ progress: ImportProgress | null; indexing?: ImportProgress | null }>({ kind: "agent.import-progress", scope: "session", version: 1,
  initial: () => ({ progress: null, indexing: null }), checkpointWhen: () => true });
function initial(): ImportProgress { return { phase: "discovering", host_id: null, threads_seen: 0, threads_imported: 0,
  threads_unchanged: 0, items_added: 0, items_unchanged: 0, assets_saved: 0, gap_count: 0, gaps: [] }; }
function unique(gaps: HistoryGap[]): HistoryGap[] { return [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()]; }
function assetGap(gap: HistoryGap): boolean {
  return gap.item_id !== null && ["missing", "changed", "unavailable"].includes(gap.code);
}
function without(gaps: HistoryGap[], removed: HistoryGap[]): HistoryGap[] {
  const keys = new Set(removed.map((gap) => JSON.stringify(gap)));
  return gaps.filter((gap) => !keys.has(JSON.stringify(gap)));
}
function message(error: unknown): string { return error instanceof Error ? error.message : "History is unavailable"; }
function addGap(progress: ImportProgress, gap: string, priority = true): void {
  progress.gap_count += 1;
  if (priority) progress.gaps.unshift(gap); else progress.gaps.push(gap);
  if (progress.gaps.length > 50) progress.gaps.pop();
}

/** One coordinator import; later callers attach to its progress instead of starting another walk. */
export class CodexImporter {
  private active: Promise<ImportProgress> | undefined;
  private readonly listeners = new Set<(progress: ImportProgress) => void>();
  constructor(private readonly session: Harness, private readonly history: HistoryStore, private readonly assetRoot: string) {}
  isRunning(): boolean { return this.active !== undefined; }
  async status(): Promise<ImportProgress> {
    const progress = (await this.session.snapshot(Progress, BACKGROUND_CONTEXT))?.progress;
    if (progress === null || progress === undefined) return initial();
    if (!this.isRunning() && ["discovering", "importing", "indexing"].includes(progress.phase)) return {
      ...progress, phase: "partial", gap_count: progress.gap_count + 1,
      gaps: ["Previous import was interrupted; run agent import codex to resume.", ...progress.gaps.slice(0, 49)],
    };
    return progress;
  }
  async run(nodes: AgentNode[], online: string[], requested: string[], call: HostCall,
    notify: (progress: ImportProgress) => void, index: () => Promise<void>): Promise<ImportProgress> {
    this.listeners.add(notify);
    try {
      if (this.active !== undefined) { notify(await this.status()); return await this.active; }
      // Claim the job before awaiting its checkpoint so concurrent callers attach.
      this.active = (async () => {
        const saved = await this.session.snapshot(Progress, BACKGROUND_CONTEXT);
        const indexing = saved?.indexing ?? (saved?.progress?.phase === "indexing" ? saved.progress : null);
        if (requested.length === 0 && indexing !== null) return this.finish(structuredClone(indexing), index);
        const selected = requested.length === 0 ? nodes : requested.map((value) => {
          const node = nodes.find((node) => node.host_id === value || node.name.toLocaleLowerCase() === value.toLocaleLowerCase());
          if (node === undefined) throw new Error("Choose a registered history host"); return node;
        });
        const hosts = [...new Map(selected.map((node) => [node.host_id, node])).values()];
        if (hosts.length === 0) throw new Error("No registered hosts are available for Codex import");
        return this.walk(hosts, online, call, index);
      })();
      return await this.active;
    } finally { this.listeners.delete(notify); if (this.listeners.size === 0) this.active = undefined; }
  }
  private async publish(progress: ImportProgress, indexing: ImportProgress | null = null): Promise<void> {
    const snapshot = structuredClone(progress);
    const checkpoint = structuredClone(indexing);
    await this.session.commit(async (tx) => {
      const state = await tx.doc(Progress); state.progress = snapshot; state.indexing = checkpoint;
    }, BACKGROUND_CONTEXT);
    for (const notify of this.listeners) notify(snapshot);
  }
  private async read(host: string, request: HistoryRequest, call: HostCall): Promise<HistoryResponse> {
    const result = await call({ type: "on_node", host_id: host, command: { type: "history", request } });
    if (result.type === "failed") throw new Error(result.message);
    if (result.type !== "history") throw new Error("History host returned another response type");
    return result.response;
  }
  private async walk(nodes: AgentNode[], online: string[], call: HostCall, index: () => Promise<void>): Promise<ImportProgress> {
    const progress = initial(); await this.publish(progress);
    // Retained text can index while source pages commit. Only finish records a
    // postwalk checkpoint, and this request retains both operations until drained.
    let indexingGap: string | undefined;
    const indexing = Promise.resolve().then(index).catch((error: unknown) => { indexingGap = `Initial search indexing: ${message(error)}`; });
    const publish = () => {
      const snapshot = { ...progress, gaps: [...progress.gaps] };
      if (indexingGap !== undefined) addGap(snapshot, indexingGap);
      return this.publish(snapshot);
    };
    try {
      for (const node of nodes) {
        progress.host_id = node.host_id;
        if (!online.includes(node.host_id)) { addGap(progress, `${node.name}: host is offline`); continue; }
        for (const archived of [false, true]) {
          let cursor: string | null = null; const cursors = new Set<string>();
          try {
            do {
              const page = await this.read(node.host_id, { type: "list", archived, cursor }, call);
              if (page.type !== "list") throw new Error("History host returned no thread inventory");
              for (const thread of page.threads) {
                const firstThread = progress.phase === "discovering";
                progress.threads_seen += 1; progress.phase = "importing";
                if (firstThread) await publish();
                try { await this.thread(node.host_id, thread, progress, call); }
                catch (error) { addGap(progress, `${node.name}: ${thread.id}: ${message(error)}`); }
                await publish();
              }
              cursor = page.next_cursor;
              if (cursor !== null) { if (cursors.has(cursor)) throw new Error("History inventory repeated a cursor"); cursors.add(cursor); }
            } while (cursor !== null);
          } catch (error) { addGap(progress, `${node.name}: ${archived ? "archived" : "active"} inventory: ${message(error)}`); }
        }
      }
      return await this.finish(progress, async () => { await indexing; await index(); });
    } finally { await indexing; }
  }
  private async finish(progress: ImportProgress, index: () => Promise<void>): Promise<ImportProgress> {
    progress.phase = "indexing"; progress.host_id = null;
    let checkpoint: ImportProgress | null = structuredClone(progress);
    await this.publish(progress, checkpoint);
    try { await index(); checkpoint = null; } catch (error) { addGap(progress, `Search indexing: ${message(error)}`); }
    progress.phase = progress.gaps.length === 0 ? "complete" : "partial";
    await this.publish(progress, checkpoint); return progress;
  }
  private async thread(host: string, thread: HistoryThread, progress: ImportProgress, call: HostCall): Promise<void> {
    const saved = await this.history.checkpoint(thread.id, host);
    if (thread.version_reliable && saved?.version === thread.version) {
      await this.history.reconcileLineage(thread);
      if (saved.complete) { progress.threads_unchanged += 1; return; }
    }
    let gaps: HistoryGap[] | undefined;
    if (thread.version_reliable && saved?.version === thread.version && saved.source_exhausted && saved.retry_pages !== undefined) {
      const planned = new Set(saved.retry_pages.flatMap((page) => page.gaps.map((gap) => JSON.stringify(gap))));
      if (saved.gaps.every((gap) => planned.has(JSON.stringify(gap)))) gaps = await this.retry(host, thread, saved.retry_pages, progress, call);
    }
    gaps ??= await this.scan(host, thread, saved, progress, call);
    progress.threads_imported += 1;
    for (const gap of gaps) addGap(progress, `${thread.id}: ${gap.message}`, gap.code !== "missing" || gap.item_id === null);
  }
  private async retain(host: string, thread: HistoryThread, page: Extract<HistoryResponse, { type: "read" }>,
    progress: ImportProgress, call: HostCall, targets?: ReadonlySet<string>): Promise<{ items: HistoryItem[]; gaps: HistoryGap[] }> {
    const items: HistoryItem[] = [], gaps = page.gaps.filter((gap) => targets === undefined || gap.item_id === null || targets.has(gap.item_id));
    for (const item of page.items) {
      if (targets !== undefined && !targets.has(item.id)) continue;
      const assets: HistoryAssetRef[] = [];
      for (const source of item.assets) {
        try { assets.push(await this.asset(host, thread.id, source, call)); progress.assets_saved += 1; }
        catch (error) { gaps.push({ code: "unavailable", item_id: item.id, message: message(error) }); }
      }
      // Keep the original native payload even while its attachments recover.
      items.push({ ...item, assets });
    }
    return { items, gaps: unique(gaps) };
  }
  private async scan(host: string, thread: HistoryThread, saved: ImportCheckpoint | undefined,
    progress: ImportProgress, call: HostCall): Promise<HistoryGap[]> {
    // Legacy partial checkpoints with gaps have no affected-page receipts.
    // Read them conservatively once; an unreliable locator cannot skip a prefix.
    const resume = thread.version_reliable && saved?.version === thread.version &&
      (saved.retry_pages !== undefined || saved.gaps.length === 0);
    let cursor = resume ? saved.next_cursor : null;
    let gaps: HistoryGap[] = cursor === null ? [] : saved?.gaps ?? [];
    let retries: HistoryRetryPage[] = cursor === null ? [] : structuredClone(saved?.retry_pages ?? []);
    const failed = retries.filter((page) => page.cursor === cursor && page.gaps.some((gap) => !assetGap(gap)));
    gaps = without(gaps, failed.flatMap((page) => page.gaps)); retries = retries.filter((page) => !failed.includes(page));
    const cursors = new Set<string>(); let resets = 0;
    // Record the current observation before an RPC can fail, so a changed or
    // unreliable locator cannot keep advertising yesterday's complete coverage.
    await this.history.import({ host_id: host, thread, items: [], next_cursor: cursor,
      gaps, complete: false, source_exhausted: false, retry_pages: retries });
    do {
      const page = await this.read(host, { type: "read", thread_id: thread.id, cursor }, call);
      if (page.type !== "read" || page.thread_id !== thread.id) throw new Error("History host returned another conversation");
      if (page.gaps.some((gap) => gap.code === "changed" && gap.item_id === null) && resets++ === 0) {
        cursor = null; gaps = []; retries = []; thread = { ...thread, version: page.version || thread.version }; continue;
      }
      if (page.version.length > 0) thread = { ...thread, version: page.version };
      const retained = await this.retain(host, thread, page, progress, call);
      gaps = unique([...gaps, ...retained.gaps]);
      const exhausted = page.source_exhausted === true || page.complete;
      const readFailed = page.next_cursor === null && !exhausted && page.gaps.some((gap) => gap.item_id === null);
      const retryGaps = readFailed ? retained.gaps : retained.gaps.filter(assetGap);
      if (retryGaps.length > 0) retries.push({ cursor, gaps: retryGaps });
      const receipt = await this.history.import({ host_id: host, thread, items: retained.items, next_cursor: readFailed ? cursor : page.next_cursor,
        gaps, complete: exhausted && gaps.length === 0, source_exhausted: exhausted, retry_pages: retries });
      progress.items_added += receipt.added_items; progress.items_unchanged += receipt.existing_items;
      if (readFailed) break;
      cursor = page.next_cursor;
      if (cursor !== null) { if (cursors.has(cursor)) throw new Error("History reader repeated a cursor"); cursors.add(cursor); }
    } while (cursor !== null);
    return gaps;
  }
  private async retry(host: string, thread: HistoryThread, saved: HistoryRetryPage[],
    progress: ImportProgress, call: HostCall): Promise<HistoryGap[] | undefined> {
    const retries = structuredClone(saved), cursors = new Set<string>();
    for (let index = 0; index < retries.length;) {
      const pending = retries[index]; if (pending === undefined) break;
      const targets = new Set(pending.gaps.filter(assetGap).flatMap((gap) => gap.item_id === null ? [] : [gap.item_id]));
      if (targets.size === 0) return undefined;
      const locator = JSON.stringify([pending.cursor, [...targets].sort()]);
      if (cursors.has(locator)) throw new Error("History reader repeated a retry cursor");
      cursors.add(locator);
      const page = await this.read(host, { type: "read", thread_id: thread.id, cursor: pending.cursor }, call);
      if (page.type !== "read" || page.thread_id !== thread.id) throw new Error("History host returned another conversation");
      if ((page.version.length > 0 && page.version !== thread.version) || page.gaps.some((gap) => gap.code === "changed" && gap.item_id === null)) return undefined;
      const retained = await this.retain(host, thread, page, progress, call, targets);
      const seen = new Set(retained.items.map((item) => item.id)), remaining = pending.gaps.filter((gap) => assetGap(gap) && gap.item_id !== null && !seen.has(gap.item_id));
      const replacements: HistoryRetryPage[] = [];
      if (remaining.length > 0 && page.next_cursor === null) {
        replacements.push({ cursor: pending.cursor, gaps: unique([...remaining, ...retained.gaps,
          ...(retained.gaps.length === 0 ? [{ code: "unavailable", item_id: null, message: "Affected history items were not returned; retained evidence is unchanged." } satisfies HistoryGap] : [])]) });
      } else {
        if (retained.gaps.length > 0) replacements.push({ cursor: pending.cursor, gaps: retained.gaps });
        if (remaining.length > 0) replacements.push({ cursor: page.next_cursor, gaps: remaining });
      }
      retries.splice(index, 1, ...replacements);
      const gaps = unique(retries.flatMap((page) => page.gaps));
      const receipt = await this.history.import({ host_id: host, thread, items: retained.items, next_cursor: null,
        gaps, complete: retries.length === 0, source_exhausted: true, retry_pages: retries });
      progress.items_added += receipt.added_items; progress.items_unchanged += receipt.existing_items;
      // Failed items wait for a later import. Follow only a new continuation
      // needed to locate this page's other affected IDs.
      if (remaining.length > 0 && page.next_cursor !== null) {
        index += retained.gaps.length > 0 ? 1 : 0;
      } else index += replacements.length;
    }
    return unique(retries.flatMap((page) => page.gaps));
  }
  private async retainedAsset(source: HistoryAssetRef): Promise<HistoryAssetRef | undefined> {
    if (source.sha256 === null || !/^[a-f0-9]{64}$/.test(source.sha256)) return;
    const destination = join(this.assetRoot, source.sha256);
    try {
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        if (!before.isFile() || source.size !== null && source.size !== before.size) return;
        const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let size = 0;
        while (true) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead)); size += bytesRead;
        }
        const after = await file.stat();
        if (size !== before.size || after.size !== size || after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs || hash.digest("hex") !== source.sha256) return;
        return { ...source, path: destination, size };
      } finally { await file.close(); }
    } catch { /* Missing or invalid local copies use the ordinary verified transfer. */ }
    return;
  }
  private async asset(host: string, thread: string, source: HistoryAssetRef, call: HostCall): Promise<HistoryAssetRef> {
    await mkdir(this.assetRoot, { recursive: true, mode: 0o700 });
    const retained = await this.retainedAsset(source);
    if (retained !== undefined) return retained;
    const temporary = join(this.assetRoot, "." + randomUUID());
    const file = await open(temporary, "wx", 0o600);
    let offset = 0; let digest: string | undefined; let total: number | undefined; const hash = createHash("sha256");
    try {
      do {
        const page = await this.read(host, { type: "asset", thread_id: thread, path: source.path, offset }, call);
        if (page.type !== "asset" || page.path !== source.path || page.offset !== offset || !/^[a-f0-9]{64}$/.test(page.sha256)) throw new Error("History asset response has an invalid identity");
        digest ??= page.sha256; total ??= page.total_bytes;
        if (digest !== page.sha256 || total !== page.total_bytes) throw new Error("History asset changed during transfer");
        const bytes = Buffer.from(page.data_base64, "base64");
        if (offset + bytes.length > total || (page.next_offset !== null && page.next_offset !== offset + bytes.length)) throw new Error("History asset has an invalid byte range");
        hash.update(bytes); await file.writeFile(bytes); offset += bytes.length;
        if (page.next_offset === null) break;
        if (bytes.length === 0) throw new Error("History asset made no progress");
      } while (true);
      if (digest === undefined || total === undefined || offset !== total || hash.digest("hex") !== digest || (source.sha256 !== null && source.sha256 !== digest)) throw new Error("History asset digest did not verify");
      await file.sync(); await file.close();
      const destination = join(this.assetRoot, digest);
      await rename(temporary, destination);
      return { ...source, path: destination, sha256: digest, size: offset };
    } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
}
