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
  sync(call: HostCall, all = false): Promise<void> {
    const operation = this.syncing.then(async () => {
      const index = this.open(); const embed = this.embed(call);
      if (!this.ready || all) {
        await index.reconcile(this.histories.inventory(), (id) => this.tasks.records(id), embed);
        this.ready = true;
      }
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
    });
    this.syncing = operation.catch(() => {}); return operation;
  }
  async search(query: string, sources: string[], limit: number, call: HostCall, importing = false, mode: SearchMode = "semantic"): Promise<SearchResult> {
    const gaps: string[] = [];
    if (!importing) {
      try { await this.sync(call); }
      catch (error) { gaps.push(error instanceof Error ? error.message : "History indexing is unavailable"); }
    } else gaps.push("Codex history import and indexing are in progress");
    try {
      const result = await this.open().search(query, this.embed(call), sources, limit, mode);
      return { candidates: result.candidates, gaps: [...gaps, ...result.gaps] };
    } catch (error) { return { candidates: [], gaps: [...gaps, error instanceof Error ? error.message : "History search is unavailable"] }; }
  }
}
