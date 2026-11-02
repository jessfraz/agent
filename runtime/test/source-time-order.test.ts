import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SourceEvent } from "../src/generated/SourceEvent.js";
import { ConversationModels } from "../src/models.js";
import { SourceJournal } from "../src/sources.js";
import { TaskStore } from "../src/tasks.js";

async function open(directory: string) {
  const storage = await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite")));
  const models = createModels();
  const session = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const sources = new SourceJournal(session, new TaskStore(session, new ConversationModels(models)));
  return { session, storage, sources };
}

function event(id: string, account = "alpha", occurred_at?: number): SourceEvent {
  return { id, version: id, source: { provider: "google", account, thread_id: id }, title: "Synthetic mail", text: "Original evidence",
    ...(occurred_at === undefined ? {} : { occurred_at }) };
}

/** Claim through production admission, then stop at the real missing-model
 * preflight boundary. No model/provider implementation or inference is needed. */
async function claim(app: Awaited<ReturnType<typeof open>>) {
  await assert.rejects(app.sources.triage({ type: "triage_sources", instructions: "", cwd: "/", hosts: [],
    model: { provider: "openai", model_id: "no-inference-for-source-order", reasoning: null, fast: false } },
  () => { assert.fail("An empty model registry must stop before execution binding"); }, []), /Unknown model/);
  const record = await app.storage.findDocument({ kind: "agent.sources", scope: { kind: "session" } }, "current", BACKGROUND_CONTEXT);
  assert.ok(record);
  const document = await app.storage.document(record.id, "current", BACKGROUND_CONTEXT);
  const active = document?.value.active;
  assert.ok(active !== null && typeof active === "object" && !Array.isArray(active));
  const keys = active.events;
  assert.ok(Array.isArray(keys));
  const selected = keys.map((key) => { assert.ok(typeof key === "string"); return key; });
  const records = new Map((await app.sources.events({ keys: selected, limit: 100 })).map((item) => [item.key, item]));
  return selected.map((key) => { const item = records.get(key); assert.ok(item); return item; });
}

test("current provider messages stay beside old work when historical catchup arrives later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-time-")); const app = await open(directory);
  try {
    const current = Date.UTC(2026, 10, 2);
    const events = [
      ...Array.from({ length: 100 }, (_, index) => event(`earlier-${index}`, "alpha", current - 86_400_000)),
      ...Array.from({ length: 3 }, (_, index) => event(`current-${index}`, "alpha", current + index)),
      ...Array.from({ length: 1000 }, (_, index) => event(`historical-${index}`, "alpha", current - 172_800_000)),
    ];
    await app.sources.admit({ source: { provider: "google", account: "alpha" }, events, coverage: { status: "complete" }, checkpoint: null }, null);
    await app.sources.admit({ source: { provider: "google", account: "beta" },
      events: Array.from({ length: 3 }, (_, index) => event(`other-${index}`, "beta", current)),
      coverage: { status: "complete" }, checkpoint: null }, null);
    const selected = await claim(app);
    assert.equal(selected.length, 20);
    assert.equal(new Set(selected.map((item) => item.key)).size, 20);
    assert.equal(selected.filter((item) => item.event.id.startsWith("current-")).length, 3,
      "Current mail must not wait behind later-admitted historical pages");
    assert.equal(selected.filter((item) => item.event.source.account === "beta").length, 3);
    assert.ok(selected.some((item) => item.event.id === "historical-0"), "Old work still advances");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("rereading legacy mail enriches ordering without changing its original version or payload across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-time-legacy-")); let app = await open(directory);
  try {
    const original = event("legacy-current"), current = Date.UTC(2026, 10, 2);
    const source = { provider: "google", account: "alpha" };
    await app.sources.admit({ source, events: [original], coverage: { status: "complete" }, checkpoint: { value: "one" } }, null);
    const historical = Array.from({ length: 1000 }, (_, index) => event(`historical-${index}`, "alpha", current - 86_400_000));
    await app.sources.admit({ source, events: historical, coverage: { status: "complete" }, checkpoint: { value: "two" } }, { value: "one" });
    const enriched = await app.sources.admit({ source, events: [{ ...original, occurred_at: current }],
      coverage: { status: "complete" }, checkpoint: { value: "three" } }, { value: "two" });
    assert.equal(enriched.new_events, 0);
    const replay = await app.sources.admit({ source, events: [original], coverage: { status: "complete" },
      checkpoint: { value: "four" } }, { value: "three" });
    assert.equal(replay.new_events, 0);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const saved = await app.sources.events({ provider: "google", account: "alpha", thread_id: original.id });
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.event, original, "An admitted source payload remains immutable");
    assert.equal(saved[0]?.occurred_at, current);
    assert.ok((await claim(app)).some((item) => item.event.id === original.id));
    assert.equal((await app.sources.states()).find((item) => item.source.account === "alpha")?.checkpoint?.value, "four");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("invalid provider times cannot mutate source evidence or advance its checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-time-invalid-")); const app = await open(directory);
  try {
    for (const time of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(app.sources.admit({ source: { provider: "google", account: "alpha" },
        events: [event("invalid", "alpha", time)], coverage: { status: "complete" }, checkpoint: { value: "invalid" } }, null),
      /Source event time/);
    }
    assert.deepEqual(await app.sources.events({ provider: "google" }), []);
    assert.ok((await app.sources.states()).every((state) => state.source.provider !== "google"));
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
