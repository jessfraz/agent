// Paired native index benchmarks for the existing performance CI job. No model
// runner is involved: deterministic document vectors are seeded before timing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { EmbeddingSpace } from "../../src/generated/EmbeddingSpace.js";
import type { Embed, SearchIndex, SearchRecord, SearchResult } from "../../src/search.js";

const conversations = 64, entries = 256, dimensions = 1024;
enum Scenario { Dense = "dense", Keyword = "keyword", CachedIndex = "cached_index" }
const scenarios = Object.values(Scenario);
type Version = "baseline" | "candidate";
type Request = { type: "sample"; scenario: Scenario; pair: number } | { type: "close" };
type Reply = { type: "ready"; seeded_ms: number; document_vectors: number }
  | { type: "sample"; elapsed_ms: number; signature: string; operations: number }
  | { type: "closed" };
type Sample = Extract<Reply, { type: "sample" }> & { scenario: Scenario; version: Version; pair: number; warmup: boolean };
const space: EmbeddingSpace = { id: "native-performance-v1", model_revision: "deterministic", model_digest: "synthetic",
  dimensions, pooling: "last", normalization: "l2", instruction_version: 1 };
const target = 17 * entries + 42, targetConversation = "conversation-17";

function vector(id: number): number[] {
  let state = id + 1;
  const values = Array.from({ length: dimensions }, () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return state / 2147483648;
  });
  const norm = Math.hypot(...values);
  return values.map(value => value / norm);
}
function record(id: number): SearchRecord {
  return { entry_id: `entry-${id}`, ordinal: id % entries, source_refs: [`synthetic:case-${Math.floor(id / entries)}`],
    text: `Record ${id}. marker${id}. Synthetic equipment service notes for category${Math.floor(id / entries)}. ` +
      "The inspection retained a supplier agreement, the replacement specification, and the completed validation. ".repeat(4) };
}
async function* records(conversation: number): AsyncIterable<SearchRecord> {
  for (let entry = 0; entry < entries; entry++) yield record(conversation * entries + entry);
}
function checked(result: SearchResult, expected: number): string {
  assert.deepEqual(result.gaps, []);
  assert.equal(result.candidates[0]?.conversation_id, `conversation-${Math.floor(expected / entries)}`);
  const match = result.candidates[0]?.matches.find(match => match.entry_id === `entry-${expected}`);
  assert.deepEqual(match, { entry_id: `entry-${expected}`, text: record(expected).text, source_refs: record(expected).source_refs });
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

async function serve(): Promise<void> {
  const location: { module: string; directory: string } = workerData;
  const owner = parentPort; assert.ok(owner);
  const source: { SearchIndex: typeof SearchIndex } = await import(pathToFileURL(location.module).href);
  const index = new source.SearchIndex(join(location.directory, "search.sqlite"));
  let documents = 0;
  const queryVector = vector(target);
  const embed: Embed = async (texts, purpose) => {
    if (purpose === "query") return { space, vectors: texts.map(() => queryVector) };
    documents += texts.length;
    return { space, vectors: texts.map(text => {
      const id = /^Record (\d+)\./u.exec(text)?.[1]; assert.ok(id);
      return vector(Number(id));
    }) };
  };
  const started = performance.now();
  for (let conversation = 0; conversation < conversations; conversation++) {
    await index.upsert(`conversation-${conversation}`, "seed", records(conversation), embed);
  }
  assert.equal(documents, conversations * entries);
  const seeded = { type: "ready", seeded_ms: performance.now() - started, document_vectors: documents } satisfies Reply;
  const query = async (scenario: "dense" | "keyword") => index.search(scenario === "dense" ? "roadworthiness" : "inspection",
    scenario === "dense" ? embed : undefined, [], 8, scenario === "dense" ? "semantic" : "keyword");
  // Establish both semantic and lexical ground truth outside the timed samples.
  checked(await query("dense"), target); checked(await query("keyword"), 0);
  owner.on("message", (request: Request) => {
    void (async () => {
      if (request.type === "close") {
        await index.close(); owner.postMessage({ type: "closed" } satisfies Reply); owner.close(); return;
      }
      const before = documents, results: SearchResult[] = [], operations = request.scenario === "cached_index" ? 4 : 8;
      const began = performance.now();
      for (let iteration = 0; iteration < operations; iteration++) {
        if (request.scenario === "cached_index") {
          await index.upsert(targetConversation, `cached-${request.pair}-${iteration}`, records(17), embed);
        } else results.push(await query(request.scenario));
      }
      const elapsed_ms = performance.now() - began;
      assert.equal(documents, before, "Published chunks must reuse vectors; timed samples never infer document vectors");
      if (request.scenario === "cached_index") {
        assert.deepEqual(index.checkpoint(targetConversation), { watermark: `cached-${request.pair}-${operations - 1}`, dirty: false });
        results.push(await query("dense"));
      }
      const signatures = results.map(result => checked(result, request.scenario === "keyword" ? 0 : target));
      assert.ok(signatures.every(signature => signature === signatures[0]));
      owner.postMessage({ type: "sample", elapsed_ms, signature: signatures[0]!, operations } satisfies Reply);
    })().catch(error => { throw error; });
  });
  owner.postMessage(seeded);
}

class Runner {
  private readonly worker: Worker;
  private pending: { resolve(value: Reply): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private failure: Error | undefined;
  private closing = false;
  readonly ready: Promise<Reply>;
  constructor(module: string, directory: string) {
    this.worker = new Worker(new URL(import.meta.url), { workerData: { module, directory } });
    this.worker.on("message", (reply: Reply) => { const pending = this.pending; this.pending = undefined;
      if (pending !== undefined) { clearTimeout(pending.timer); pending.resolve(reply); } });
    this.worker.on("error", error => this.fail(error instanceof Error ? error : new Error("Native benchmark worker failed")));
    this.worker.on("exit", code => { if (!this.closing) this.fail(new Error(`Native benchmark worker exited: ${code}`)); });
    this.ready = this.receive(60_000);
  }
  private fail(error: Error): void {
    this.failure ??= error;
    if (this.pending !== undefined) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
  }
  private receive(deadline: number): Promise<Reply> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    assert.equal(this.pending, undefined);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => this.fail(new Error("Native benchmark response deadline elapsed")), deadline) };
    });
  }
  sample(scenario: Scenario, pair: number): Promise<Reply> {
    const reply = this.receive(20_000); this.worker.postMessage({ type: "sample", scenario, pair } satisfies Request); return reply;
  }
  async close(): Promise<void> {
    try {
      if (this.failure === undefined) {
        this.closing = true;
        const reply = this.receive(20_000); this.worker.postMessage({ type: "close" } satisfies Request);
        assert.equal((await reply).type, "closed");
      }
    } finally { await this.worker.terminate(); }
  }
}

export function comparisons(samples: Sample[]) {
  return scenarios.map(scenario => {
    const median = (version: Version) => {
      const values = samples.filter(sample => sample.scenario === scenario && sample.version === version && !sample.warmup)
        .map(sample => sample.elapsed_ms).sort((left, right) => left - right);
      assert.ok(values.length >= 3); return values[Math.floor(values.length / 2)]!;
    };
    const baseline_median_ms = median("baseline"), candidate_median_ms = median("candidate");
    const allowed_ms = Math.max(baseline_median_ms * 1.25, baseline_median_ms + 20);
    return { scenario, baseline_median_ms, candidate_median_ms, allowed_ms, passed: candidate_median_ms <= allowed_ms };
  });
}

async function run(): Promise<void> {
  const { values } = parseArgs({ options: { baseline: { type: "string" }, candidate: { type: "string" },
    output: { type: "string", default: "performance/search.json" }, samples: { type: "string", default: "7" } } });
  assert.ok(values.baseline); assert.ok(values.candidate);
  const count = Number(values.samples); assert.ok(Number.isInteger(count) && count >= 3 && count <= 31);
  const output = resolve(values.output), raw = output.replace(/\.json$/u, "") + ".jsonl", failure = output + ".failure.json";
  await mkdir(dirname(output), { recursive: true });
  for (const path of [output, raw, failure]) await rm(path, { force: true });
  const directory = await mkdtemp(join(tmpdir(), "agent-search-performance-"));
  const runners: Runner[] = [], samples: Sample[] = [], errors: unknown[] = [];
  try {
    const baseline = new Runner(resolve(values.baseline), join(directory, "baseline")); runners.push(baseline);
    const baselineSeed = await baseline.ready; assert.equal(baselineSeed.type, "ready");
    const candidate = new Runner(resolve(values.candidate), join(directory, "candidate")); runners.push(candidate);
    const candidateSeed = await candidate.ready; assert.equal(candidateSeed.type, "ready");
    for (const scenario of scenarios) for (let pair = 0; pair <= count; pair++) {
      const order: Version[] = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      let signature: string | undefined;
      for (const version of order) {
        const reply = await (version === "baseline" ? baseline : candidate).sample(scenario, pair); assert.equal(reply.type, "sample");
        if (reply.type !== "sample") throw new Error("Native sample response is missing");
        signature ??= reply.signature; assert.equal(reply.signature, signature, "Baseline/candidate ranking, hydration and provenance must agree");
        const sample = { ...reply, scenario, version, pair, warmup: pair === 0 }; samples.push(sample);
        await appendFile(raw, JSON.stringify(sample) + "\n");
      }
    }
    const results = comparisons(samples);
    await writeFile(output, JSON.stringify({ schema: 1, metric: "native_search_and_cached_index_batch", conversations,
      entries_per_conversation: entries, dimensions, relative_allowance: 0.25, absolute_allowance_ms: 20,
      baseline_seed: baselineSeed, candidate_seed: candidateSeed, samples, comparisons: results }, null, 2) + "\n");
    for (const result of results) console.log(`${result.scenario}: base ${result.baseline_median_ms.toFixed(1)} ms, ` +
      `candidate ${result.candidate_median_ms.toFixed(1)} ms, limit ${result.allowed_ms.toFixed(1)} ms, ${result.passed ? "pass" : "REGRESSION"}`);
    assert.ok(results.every(result => result.passed), `Native search/index performance regressed; raw samples: ${raw}`);
  } catch (error) { errors.push(error); }
  for (const result of await Promise.allSettled(runners.map(runner => runner.close()))) if (result.status === "rejected") errors.push(result.reason);
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length > 0) {
    await writeFile(failure, JSON.stringify({ errors: errors.map(error => error instanceof Error ? error.message : "Native benchmark failed") }, null, 2) + "\n");
    throw new AggregateError(errors, "Native search/index benchmark failed");
  }
}

if (!isMainThread) await serve();
else if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
