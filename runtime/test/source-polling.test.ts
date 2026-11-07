import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openConversationDatabase } from "../src/conversation-database.js";
import type { SourceBatch } from "../src/generated/SourceBatch.js";
import type { SourceEvent } from "../src/generated/SourceEvent.js";
import { SourceJournal } from "../src/sources.js";
import { TaskStore } from "../src/tasks.js";

async function open(path: string) {
  const storage = await SqliteStorage.open(await openConversationDatabase(path));
  const session = await Harness.open(storage,
    { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  return { session, sources: new SourceJournal(session, new TaskStore(session)) };
}
function event(id: string, text: string, version = "v1"): SourceEvent {
  return { id, version, source: { provider: "chat", account: "example", thread_id: id }, title: id, text };
}
function batch(events: SourceEvent[], cursor: string): SourceBatch {
  return { source: { provider: "chat", account: "example" }, events,
    checkpoint: { value: cursor }, coverage: { status: "complete" } };
}

test("a conflicting source version blocks only its batch while other source admission continues across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-poll-conflict-")), path = join(directory, "session.sqlite");
  let app = await open(path);
  try {
    const original = event("retained", "Immutable original");
    await app.sources.admit(batch([original], "first"), null);
    const saved = (await app.sources.events())[0]; assert.ok(saved);
    await app.sources.decide([saved.key], { type: "dismissed", reason: "Already reviewed" });
    const retained = (await app.sources.events())[0]; assert.ok(retained);

    const blocked = await app.sources.admit(batch([
      event("must-not-partially-admit", "New event in the rejected batch"),
      { ...original, title: "Changed title under the same version" },
    ], "unsafe"), { value: "first" });
    assert.equal(blocked.new_events, 0);
    assert.equal(blocked.checkpoint_advanced, false);
    assert.deepEqual(blocked.state.checkpoint, { value: "first" });
    assert.deepEqual(blocked.state.coverage, { status: "unavailable",
      message: "Source content changed without a new version (title); checkpoint retained." });
    assert.deepEqual(await app.sources.events(), [retained], "No original, decision or new event may change on conflict");

    const mail: SourceBatch = { source: { provider: "mail", account: "personal" },
      events: [{ ...event("fresh-parcel", "New shipping evidence"), source: {
        provider: "mail", account: "personal", thread_id: "parcel-thread" } }],
      checkpoint: { value: "mail-current" }, coverage: { status: "complete" } };
    assert.equal((await app.sources.admit(mail, null)).new_events, 1,
      "An unrelated source must remain reachable in the same poll invocation");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(path);
    assert.deepEqual((await app.sources.states()).find(state => state.source.provider === "chat"), blocked.state);
    assert.deepEqual((await app.sources.states()).find(state => state.source.provider === "mail")?.checkpoint, mail.checkpoint);
    assert.deepEqual((await app.sources.events({ provider: "chat" }))[0], retained);
    assert.deepEqual((await app.sources.events({ provider: "mail" }))[0]?.event, mail.events[0]);

    const repaired = await app.sources.admit(batch([event("retained", "Correctly versioned update", "v2")], "second"), { value: "first" });
    assert.equal(repaired.new_events, 1); assert.equal(repaired.checkpoint_advanced, true);
    assert.deepEqual(repaired.state.coverage, { status: "complete" });
    assert.deepEqual((await app.sources.events({ keys: [saved.key] }))[0], retained);
    const stale = await app.sources.admit(batch([{ ...original, text: "Stale conflicting content" }], "unsafe"), { value: "first" });
    assert.deepEqual(stale.state, repaired.state, "A stale failed read must not replace newer canonical coverage");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("conflicting duplicate versions within one source page retain the entire prior checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-page-conflict-")), app = await open(join(directory, "session.sqlite"));
  try {
    const result = await app.sources.admit(batch([event("duplicate", "First content"), event("duplicate", "Conflicting content")], "unsafe"), null);
    assert.equal(result.new_events, 0); assert.equal(result.checkpoint_advanced, false);
    assert.equal(result.state.checkpoint, null); assert.equal(result.state.coverage.status, "unavailable");
    assert.deepEqual(await app.sources.events(), []);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("unchanged legacy revisions retain their original decisions across reopen while a genuine edit is admitted once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-legacy-version-")), path = join(directory, "session.sqlite");
  let app = await open(path);
  try {
    const legacy = event("retained", "Original text");
    await app.sources.admit(batch([legacy], "first"), null);
    const saved = (await app.sources.events())[0]; assert.ok(saved);
    await app.sources.decide([saved.key], { type: "dismissed", reason: "Already handled" });
    const retained = (await app.sources.events())[0]; assert.ok(retained);
    const current = { ...legacy, version: "content-revision-one", legacy_version: legacy.version };
    for (let index = 0; index < 2; index += 1) {
      const replay = await app.sources.admit(batch([current], "first"), { value: "first" });
      assert.equal(replay.new_events, 0); assert.equal(replay.checkpoint_advanced, false);
      assert.deepEqual(await app.sources.events(), [retained]);
      await app.session.close(BACKGROUND_CONTEXT); app = await open(path);
    }
    const updated = { ...current, version: "content-revision-two", text: "Actually edited text" };
    const changed = await app.sources.admit(batch([updated], "second"), { value: "first" });
    assert.equal(changed.new_events, 1); assert.equal(changed.checkpoint_advanced, true);
    assert.deepEqual(changed.state.checkpoint, { value: "second" });
    await app.session.close(BACKGROUND_CONTEXT); app = await open(path);
    assert.equal((await app.sources.admit(batch([updated], "second"), { value: "second" })).new_events, 0);
    assert.equal((await app.sources.admit(batch([current], "second"), { value: "second" })).new_events, 0);
    assert.deepEqual((await app.sources.events({ keys: [saved.key] }))[0], retained);
    assert.equal((await app.sources.events({ pending: true })).length, 1);
    assert.equal((await app.sources.events()).length, 2);
    assert.equal((await app.session.inspect(BACKGROUND_CONTEXT)).tasks.length, 0, "An unchanged handled page must not start work");

    // An exact new-version collision remains a failure even when its content
    // happens to equal the legacy original named by its compatibility hint.
    const collision = await app.sources.admit(batch([{ ...current, version: updated.version }], "unsafe"), { value: "second" });
    assert.equal(collision.new_events, 0); assert.equal(collision.state.coverage.status, "unavailable");
    assert.deepEqual(collision.state.checkpoint, { value: "second" });
    assert.deepEqual((await app.sources.events({ keys: [saved.key] }))[0], retained);
    assert.deepEqual((await app.sources.events({ pending: true }))[0]?.event, updated);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("legacy hints require the exact source, message, version and normalized content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-legacy-boundaries-")), app = await open(join(directory, "session.sqlite"));
  try {
    const legacy = event("retained", "Original text");
    await app.sources.admit(batch([legacy], "first"), null);
    const saved = (await app.sources.events())[0]; assert.ok(saved);
    const current = { ...legacy, legacy_version: legacy.version };
    const variants: SourceEvent[] = [
      { ...current, id: "another-message" },
      { ...current, source: { ...current.source, account: "another-account" } },
      { ...current, source: { ...current.source, provider: "another-provider" } },
      { ...current, source: { ...current.source, thread_id: "another-thread" } },
      { ...current, title: "Changed normalized title" },
      { ...current, text: "Changed normalized text" },
      { ...current, legacy_version: "another-legacy-version" },
    ];
    for (const [index, value] of variants.entries()) {
      const candidate = { ...value, version: `new-revision-${index}` };
      const expected = (await app.sources.states()).find(state => state.source.provider === candidate.source.provider &&
        state.source.account === candidate.source.account)?.checkpoint ?? null;
      const read = { ...batch([candidate], `next-${index}`), source: {
        provider: candidate.source.provider, account: candidate.source.account } };
      assert.equal((await app.sources.admit(read, expected)).new_events, 1);
    }
    assert.deepEqual((await app.sources.events({ keys: [saved.key] }))[0], saved);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
