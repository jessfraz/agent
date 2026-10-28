import { createHash, randomUUID } from "node:crypto";
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
import type { HistoryThread } from "./generated/HistoryThread.js";
import type { ImportProgress } from "./generated/ImportProgress.js";
import type { HostCall } from "./tasks.js";
import type { HistoryStore } from "./history.js";

const Progress = defineDoc<{ progress: ImportProgress | null }>({ kind: "agent.import-progress", scope: "session", version: 1,
  initial: () => ({ progress: null }), checkpointWhen: () => true });
function initial(): ImportProgress { return { phase: "discovering", host_id: null, threads_seen: 0, threads_imported: 0,
  threads_unchanged: 0, items_added: 0, items_unchanged: 0, assets_saved: 0, gap_count: 0, gaps: [] }; }
function unique(gaps: HistoryGap[]): HistoryGap[] { return [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()]; }
function message(error: unknown): string { return error instanceof Error ? error.message : "History is unavailable"; }
function addGap(progress: ImportProgress, gap: string): void { progress.gap_count += 1; if (progress.gaps.length < 50) progress.gaps.push(gap); }

/** One coordinator import; later callers attach to its progress instead of starting another walk. */
export class CodexImporter {
  private active: Promise<ImportProgress> | undefined;
  private readonly listeners = new Set<(progress: ImportProgress) => void>();
  constructor(private readonly session: Harness, private readonly history: HistoryStore, private readonly assetRoot: string) {}
  isRunning(): boolean { return this.active !== undefined; }
  async status(): Promise<ImportProgress> { return (await this.session.snapshot(Progress, BACKGROUND_CONTEXT))?.progress ?? initial(); }
  async run(nodes: AgentNode[], online: string[], requested: string[], call: HostCall,
    notify: (progress: ImportProgress) => void, index: () => Promise<void>): Promise<ImportProgress> {
    this.listeners.add(notify);
    try {
      if (this.active !== undefined) { notify(await this.status()); return await this.active; }
      const selected = requested.length === 0 ? nodes : requested.map((value) => {
        const node = nodes.find((node) => node.host_id === value || node.name.toLocaleLowerCase() === value.toLocaleLowerCase());
        if (node === undefined) throw new Error("Choose a registered history host"); return node;
      });
      const hosts = [...new Map(selected.map((node) => [node.host_id, node])).values()];
      if (hosts.length === 0) throw new Error("No registered hosts are available for Codex import");
      this.active = this.walk(hosts, online, call, index);
      return await this.active;
    } finally { this.listeners.delete(notify); if (this.listeners.size === 0) this.active = undefined; }
  }
  private async publish(progress: ImportProgress): Promise<void> {
    const snapshot = structuredClone(progress);
    await this.session.commit(async (tx) => { (await tx.doc(Progress)).progress = snapshot; }, BACKGROUND_CONTEXT);
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
              progress.threads_seen += 1; progress.phase = "importing";
              try { await this.thread(node.host_id, thread, progress, call); }
              catch (error) { addGap(progress, `${node.name}: ${thread.id}: ${message(error)}`); }
              await this.publish(progress);
            }
            cursor = page.next_cursor;
            if (cursor !== null) { if (cursors.has(cursor)) throw new Error("History inventory repeated a cursor"); cursors.add(cursor); }
          } while (cursor !== null);
        } catch (error) { addGap(progress, `${node.name}: ${archived ? "archived" : "active"} inventory: ${message(error)}`); }
      }
    }
    progress.phase = "indexing"; progress.host_id = null; await this.publish(progress);
    try { await index(); } catch (error) { addGap(progress, `Search indexing: ${message(error)}`); }
    progress.phase = progress.gaps.length === 0 ? "complete" : "partial";
    await this.publish(progress); return progress;
  }
  private async thread(host: string, thread: HistoryThread, progress: ImportProgress, call: HostCall): Promise<void> {
    const saved = await this.history.checkpoint(thread.id, host);
    if (thread.version_reliable && saved?.version === thread.version && saved.complete) { progress.threads_unchanged += 1; return; }
    let cursor = saved?.version === thread.version ? saved.next_cursor : null;
    let gaps: HistoryGap[] = cursor === null ? [] : saved?.gaps ?? [];
    const cursors = new Set<string>(); let resets = 0;
    // Record the current observation before an RPC can fail, so a changed or
    // unreliable locator cannot keep advertising yesterday's complete coverage.
    await this.history.import({ host_id: host, thread, items: [], next_cursor: cursor,
      gaps: [], complete: false });
    do {
      const page = await this.read(host, { type: "read", thread_id: thread.id, cursor }, call);
      if (page.type !== "read" || page.thread_id !== thread.id) throw new Error("History host returned another conversation");
      if (page.gaps.some((gap) => gap.code === "changed") && resets++ === 0) { cursor = null; gaps = []; thread = { ...thread, version: page.version }; continue; }
      if (page.version.length > 0) thread = { ...thread, version: page.version };
      const items: HistoryItem[] = [];
      for (const item of page.items) {
        const assets: HistoryAssetRef[] = [];
        let retained = true;
        for (const source of item.assets) {
          try { assets.push(await this.asset(host, thread.id, source, call)); progress.assets_saved += 1; }
          catch (error) { retained = false; gaps.push({ code: "missing", item_id: item.id, message: message(error) }); }
        }
        if (!retained) continue;
        // Native payloads already retain their original media locators. Keep
        // their shape so full text and cold evidence remain readable.
        items.push({ ...item, assets });
      }
      gaps = unique([...gaps, ...page.gaps]);
      const receipt = await this.history.import({ host_id: host, thread, items, next_cursor: page.next_cursor,
        gaps, complete: page.complete && gaps.length === 0 });
      progress.items_added += receipt.added_items; progress.items_unchanged += receipt.existing_items;
      cursor = page.next_cursor;
      if (cursor !== null) { if (cursors.has(cursor)) throw new Error("History reader repeated a cursor"); cursors.add(cursor); }
    } while (cursor !== null);
    progress.threads_imported += 1;
    for (const gap of gaps) addGap(progress, `${thread.id}: ${gap.message}`);
  }
  private async asset(host: string, thread: string, source: HistoryAssetRef, call: HostCall): Promise<HistoryAssetRef> {
    await mkdir(this.assetRoot, { recursive: true, mode: 0o700 });
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
