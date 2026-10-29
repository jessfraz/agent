import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { HostCall, TaskStore } from "./tasks.js";
import type { HistoryStore } from "./history.js";
import { SearchIndex, type Embed, type SearchResult } from "./search.js";
import type { SearchMode } from "./generated/SearchMode.js";

/** Commit notifications enqueue work; indexing never reenters the Pi commit. */
export class Retrieval {
  private index: SearchIndex | undefined;
  private ready = false;
  private readonly dirty = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private syncing = Promise.resolve();
  private pendingSyncs = 0;
  constructor(session: Harness, private readonly histories: HistoryStore, private readonly tasks: TaskStore, private readonly path: string) {
    this.unsubscribe = session.subscribeCommits((publication) => {
      for (const change of publication.changes) if (change.type === "entry") {
        this.dirty.set(change.value.conversationId.toString(), change.value.id.toString());
      }
    });
  }
  close(): void { this.unsubscribe(); this.index?.close(); }
  private open(): SearchIndex { return this.index ??= new SearchIndex(this.path); }
  private embed(call: HostCall): Embed {
    return async (texts, purpose) => {
      const result = await call({ type: "embed", texts, purpose });
      if (result.type === "failed") throw new Error(result.message);
      if (result.type !== "embeddings") throw new Error("Embedding host returned another response type");
      return result.batch;
    };
  }
  private queue(action: () => Promise<void>): Promise<void> {
    this.pendingSyncs += 1;
    const operation = this.syncing.then(action).finally(() => { this.pendingSyncs -= 1; });
    this.syncing = operation.catch(() => {}); return operation;
  }
  private async changed(call: HostCall): Promise<void> {
    const index = this.open(), embed = this.embed(call);
    for (const [id, queued] of [...this.dirty]) {
      const checkpoint = index.checkpoint(id);
      if (checkpoint?.watermark === queued && !checkpoint.dirty) {
        if (this.dirty.get(id) === queued) this.dirty.delete(id);
        continue;
      }
      const conversation = await this.tasks.conversation(id);
      const tail = await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
      const watermark = tail.items[0]?.id.toString() ?? "empty";
      await index.upsert(id, watermark, this.tasks.records(id), embed);
      if (this.dirty.get(id) === watermark) this.dirty.delete(id);
    }
  }
  /** Full catchup keeps the explicit import request's host-call ownership. */
  sync(call: HostCall, all = false): Promise<void> {
    return this.queue(async () => {
      if (!this.ready || all) {
        await this.open().reconcile(this.histories.inventory(), (id) => this.tasks.records(id), this.embed(call));
        this.ready = true;
      }
      await this.changed(call);
    });
  }
  /** Automatic context must not hold user admission behind corpus catchup. */
  async snapshot(query: string, sources: string[], limit: number): Promise<SearchResult> {
    const coverage = "Automatic context includes published keyword matches and current task metadata only. Use search_tasks for semantic lookup before starting separate work when this context is insufficient.";
    try {
      const result = await this.open().search(query, undefined, sources, limit, "keyword");
      return { candidates: result.candidates, gaps: [coverage, ...result.gaps] };
    } catch (error) {
      return { candidates: [], gaps: [coverage, error instanceof Error ? error.message : "History search is unavailable"] };
    }
  }
  async search(query: string, sources: string[], limit: number, call: HostCall, importing = false, mode: SearchMode = "semantic"): Promise<SearchResult> {
    const gaps: string[] = [];
    // Reads can refresh their own observed commits, but never enqueue behind
    // an owned corpus catchup or turn a cold process into a full-index owner.
    if (!importing && this.pendingSyncs === 0 && this.dirty.size > 0) {
      try { await this.queue(() => this.changed(call)); }
      catch (error) { gaps.push(error instanceof Error ? error.message : "History indexing is unavailable"); }
    }
    if (importing) gaps.push("Codex history import and indexing are in progress");
    else if (this.pendingSyncs > 0) gaps.push("History indexing is in progress; results use the published index");
    else if (!this.ready) gaps.push("History index freshness is unverified; results use the published index");
    try {
      const result = await this.open().search(query, this.embed(call), sources, limit, mode);
      return { candidates: result.candidates, gaps: [...gaps, ...result.gaps] };
    } catch (error) { return { candidates: [], gaps: [...gaps, error instanceof Error ? error.message : "History search is unavailable"] }; }
  }
}
