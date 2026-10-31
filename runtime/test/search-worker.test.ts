import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { test } from "node:test";
import { SearchIndex, type Embed, type PublishedSearch, type SearchRecord, type SearchResult } from "../src/search.js";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";

const space: EmbeddingSpace = { id: "file-reader-fixture", model_revision: "synthetic", model_digest: "synthetic",
  dimensions: 1024, pooling: "last", normalization: "l2", instruction_version: 1 };
const embed: Embed = async (texts) => ({ space, vectors: texts.map(() => [1, ...Array<number>(1023).fill(0)]) });
async function* records(count: number): AsyncIterable<SearchRecord> {
  for (let ordinal = 0; ordinal < count; ordinal++) yield { entry_id: `entry-${ordinal}`, ordinal,
    text: `Automobile service evidence ${ordinal}`, source_refs: ["mail:synthetic:service"] };
}

test("warm file-backed dense search services queued coordinator I/O before returning and closes pending reads", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-file-search-"));
  const index = new SearchIndex(join(directory, "search.sqlite")), channel = new MessageChannel();
  try {
    await index.upsert("service", "one", records(4096), embed);
    await index.search("Automobile", embed); // Exercise the existing warm reader, not just worker startup.
    await index.search("Automobile", undefined, [], 1, "keyword");
    let finished = false;
    const served = new Promise<void>((resolve, reject) => channel.port1.once("message", () => {
      try { assert.equal(finished, false, "A dense read must not hold queued coordinator I/O behind its result"); resolve(); }
      catch (error) { reject(error); }
    }));
    channel.port2.postMessage("steering admission");
    const reading = index.search("Automobile", embed).then((value) => { finished = true; return value; });
    await served;
    assert.equal((await reading).candidates[0]?.conversation_id, "service");

    const closed = new Promise<void>((resolve, reject) => channel.port1.once("message", () => {
      void Promise.resolve(index.close()).then(resolve, reject);
    }));
    channel.port2.postMessage("coordinator shutdown");
    const first = assert.rejects(index.search("Automobile", embed), /closed/);
    const second = assert.rejects(index.search("Automobile", undefined, [], 1, "keyword"), /closed/);
    await closed; await Promise.all([first, second]);
    await assert.rejects(index.search("Automobile", embed), /closed/);
  } finally { channel.port1.close(); channel.port2.close(); await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("literal chat context does not queue behind a burst of real vector scans", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-reader-lanes-"));
  const index = new SearchIndex(join(directory, "search.sqlite"));
  const scans: Promise<SearchResult>[] = [];
  try {
    await index.upsert("service", "one", records(8192), embed);
    await index.search("Automobile", embed);
    await index.search("Automobile", undefined, [], 1, "keyword");
    let completed = 0;
    for (let i = 0; i < 64; i++) scans.push(index.search("transport", embed).then(result => {
      completed += 1; return result;
    }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(completed < scans.length, "The vector burst must still be running");
    const literal = await index.search("Automobile", undefined, [], 1, "keyword");
    assert.equal(literal.candidates[0]?.conversation_id, "service");
    assert.ok(completed < scans.length, "Literal context must finish before the dense backlog drains");
    for (const result of await Promise.all(scans)) assert.equal(result.candidates[0]?.conversation_id, "service");
  } finally {
    await Promise.allSettled(scans);
    await index.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("file-backed reader startup errors reject every waiter and a fresh owner can reopen the publication", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-reader-error-"));
  const publication = join(directory, "publication"), locator = join(directory, "reader");
  await mkdir(publication); await symlink(publication, locator, "dir");
  const path = join(locator, "search.sqlite"); let index = new SearchIndex(path);
  try {
    await index.upsert("service", "one", records(3), embed);
    // Remove the reader's database locator, not a library the native loader may
    // already retain from the writer in this process.
    await unlink(locator);
    await Promise.all([assert.rejects(index.search("Automobile", embed), /unable to open database file/),
      assert.rejects(index.search("Automobile", embed), /unable to open database file/)]);
    await assert.rejects(index.search("Automobile", embed), /unable to open database file/);
    await index.close(); await symlink(publication, locator, "dir"); index = new SearchIndex(path);
    assert.equal((await index.search("Automobile", embed)).candidates[0]?.conversation_id, "service");
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("file and memory searches share semantic, keyword, exact-source ranking and coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-reader-parity-"));
  const file = new SearchIndex(join(directory, "search.sqlite")), memory = new SearchIndex(":memory:");
  const selected: EmbeddingSpace = { instruction_version: space.instruction_version, normalization: space.normalization,
    pooling: space.pooling, dimensions: 3, model_digest: space.model_digest, model_revision: space.model_revision, id: space.id };
  const embedding: Embed = async (texts) => ({ space: selected, vectors: texts.map(text => /automobile|transport/u.test(text) ? [1, 0, 0] : [0, 0, 1]) });
  const values = [{ entry_id: "automobile", ordinal: 0, text: "Automobile tire repair 🚗", source_refs: ["mail:synthetic:repair"], gaps: ["Original attachment unavailable"] },
    { entry_id: "cake", ordinal: 0, text: "Transport paperwork for the cake delivery", source_refs: ["mail:synthetic:cake"] },
    { entry_id: "letter", ordinal: 0, text: "An unrelated letter", source_refs: [] }];
  try {
    for (const index of [file, memory]) for (const value of values) {
      await index.upsert(value.entry_id, "one", (async function* () { yield value; })(), embedding);
    }
    assert.deepEqual((await file.search("transport", embedding)).gaps, ["Original attachment unavailable"],
      "Equivalent typed space fields must not fail because their JSON property order differs");
    for (const mode of ["semantic", "keyword"] satisfies ("semantic" | "keyword")[]) {
      for (const refs of [[], ["mail:synthetic:repair"]]) {
        assert.deepEqual(await file.search("transport", embedding, refs, 3, mode), await memory.search("transport", embedding, refs, 3, mode));
      }
      const failed: Embed = async () => { throw new Error("Fixture embedding was canceled"); };
      assert.deepEqual(await file.search("Automobile", failed, [], 3, mode), await memory.search("Automobile", failed, [], 3, mode));
    }
  } finally { await Promise.all([file.close(), memory.close()]); await rm(directory, { recursive: true, force: true }); }
});

test("native ranking and hydration retain one old publication while another owner replaces reused rowids", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-reader-snapshot-")), path = join(directory, "search.sqlite");
  const index = new SearchIndex(path), extension = process.env.AGENT_SQLITE_VEC; assert.ok(extension);
  const gate = new Int32Array(new SharedArrayBuffer(4)); let worker: Worker | undefined;
  try {
    await index.upsert("service", "one", records(3), embed);
    const expected = await index.search("Automobile", embed, ["mail:synthetic:service"]);
    const input: PublishedSearch = { query: "Automobile", vector: new Uint8Array(new Float32Array([1, ...Array<number>(1023).fill(0)]).buffer),
      space, source_refs: ["mail:synthetic:service"], limit: 8, mode: "semantic", gaps: [] };
    const observer = new Worker(new URL("./fixtures/search-snapshot.js", import.meta.url), { workerData: { path, extension, input, gate: gate.buffer } });
    worker = observer;
    let acquired = () => {};
    const snapshot = new Promise<void>((resolve) => { acquired = resolve; });
    const completed = new Promise<{ result: SearchResult; writeRejected: boolean; changes: number; plans: unknown }>((resolve, reject) => {
      observer.on("error", reject);
      observer.on("message", (value: { type: "snapshot" } | { type: "result"; result: SearchResult; writeRejected: boolean; changes: number; plans: unknown }) => {
        if (value.type === "snapshot") acquired(); else resolve(value);
      });
    });
    await Promise.race([snapshot, completed.then(() => { throw new Error("The native read did not acquire its snapshot barrier"); })]);
    await index.delete("service");
    await index.upsert("replacement", "two", (async function* () { yield { entry_id: "replacement-entry", ordinal: 0,
      text: "Replacement automobile information", source_refs: ["mail:synthetic:replacement"] }; })(), embed);
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    const observed = await completed;
    assert.deepEqual(observed.result, expected, "Ranks must hydrate the same publication even after the rowids were replaced");
    assert.equal(observed.writeRejected, true); assert.equal(observed.changes, 0);
    t.diagnostic(JSON.stringify({ actualReaderQueryPlans: observed.plans }));
    assert.equal((await index.search("Automobile", embed)).candidates[0]?.conversation_id, "replacement");
  } finally { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); await worker?.terminate(); await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("closing during a caller-owned embedding await cannot start a late file read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-reader-embedding-")), path = join(directory, "search.sqlite");
  let index = new SearchIndex(path), release = () => {}, entered = () => {};
  const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
  try {
    await index.upsert("service", "one", records(1), embed);
    const reading = assert.rejects(index.search("Automobile", async (texts, purpose) => { entered(); await held; return embed(texts, purpose); }), /closed/);
    await began; await index.close(); release(); await reading;
    index = new SearchIndex(path);
    assert.equal((await index.search("Automobile", embed)).candidates[0]?.conversation_id, "service");
  } finally { release(); await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a native snapshot read accepts a publisher signal released before its wait", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-reader-early-signal-")), path = join(directory, "search.sqlite");
  const index = new SearchIndex(path), extension = process.env.AGENT_SQLITE_VEC; assert.ok(extension);
  const gate = new Int32Array(new SharedArrayBuffer(4)); let worker: Worker | undefined;
  try {
    await index.upsert("service", "one", records(3), embed);
    const expected = await index.search("Automobile", embed);
    Atomics.store(gate, 0, 1);
    const input: PublishedSearch = { query: "Automobile", vector: new Uint8Array(new Float32Array([1, ...Array<number>(1023).fill(0)]).buffer),
      space, source_refs: [], limit: 8, mode: "semantic", gaps: [] };
    const observer = new Worker(new URL("./fixtures/search-snapshot.js", import.meta.url), { workerData: { path, extension, input, gate: gate.buffer } });
    worker = observer;
    const result = await new Promise<SearchResult>((resolve, reject) => {
      observer.on("error", reject);
      observer.on("message", (value: { type: "snapshot" } | { type: "result"; result: SearchResult }) => {
        if (value.type === "result") resolve(value.result);
      });
    });
    assert.deepEqual(result, expected);
  } finally { await worker?.terminate(); await index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("close immediately retires the writable owner while its read worker terminates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-reader-retire-")), path = join(directory, "search.sqlite");
  let index = new SearchIndex(path);
  try {
    await index.upsert("service", "one", records(1), embed); await index.search("Automobile", embed);
    const closing = index.close();
    await assert.rejects(index.upsert("late", "after-close", records(0), embed), /closed|not open/);
    await closing; index = new SearchIndex(path);
    assert.equal(index.checkpoint("late"), undefined);
    assert.equal((await index.search("Automobile", embed)).candidates[0]?.conversation_id, "service");
  } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
});
