import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { watchMainNotices } from "../src/main_observation.js";
import { history, transcript } from "../src/transcript.js";
import { annotateTranscript, readTranscriptVisibility, TranscriptVisibility } from "../src/transcript_visibility.js";

async function open(directory: string) {
  return Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
}
function visible(frames: Awaited<ReturnType<typeof history>>) { return frames.flatMap((frame) => frame.messages); }

test("exact transcript classifications hide only selected legacy entries after reopen without changing their originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-transcript-visibility-")); let session = await open(directory);
  try {
    let root = await session.root(BACKGROUND_CONTEXT);
    const saved = await session.commit(async (tx) => {
      const receipt = await tx.appendEntry(root.id, { kind: "agent.notice", model: [fauxAssistantMessage("The state is recorded.")] });
      const useful = await tx.appendEntry(root.id, { kind: "agent.notice", model: [fauxAssistantMessage("The state is recorded.")] });
      const control = await tx.appendEntry(root.id, { kind: "agent.input", model: [{ role: "user", content: "Synthetic maintenance control", timestamp: 1 }] });
      const answer = await tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage("Synthetic maintenance receipt")] });
      return { receipt, useful, control, answer };
    }, BACKGROUND_CONTEXT);
    const original = (await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
    const context = await root.context(BACKGROUND_CONTEXT);
    assert.equal(visible(await history(root, null, session)).filter((message) => message.text === "The state is recorded.").length, 2);
    await annotateTranscript(session, root, [
      { entry_id: saved.receipt.id.toString(), classification: "internal_receipt" },
      { entry_id: saved.control.id.toString(), classification: "maintenance_control" },
      { entry_id: saved.answer.id.toString(), classification: "maintenance_control" },
    ]);
    let rendered = visible(await history(root, null, session));
    assert.deepEqual(rendered.map((message) => message.entry_id), [saved.useful.id.toString()]);
    assert.deepEqual((await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items, original);
    assert.deepEqual(await root.context(BACKGROUND_CONTEXT), context, "Visibility must not edit model context or immutable source evidence");
    assert.equal(original.flatMap(transcript).length, 4);
    await session.close(BACKGROUND_CONTEXT); session = await open(directory); root = await session.root(BACKGROUND_CONTEXT);
    assert.deepEqual(visible(await history(root, null, session)), rendered);
    assert.deepEqual((await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items, original);
    await annotateTranscript(session, root, [{ entry_id: saved.receipt.id.toString(), classification: "visible" }]);
    rendered = visible(await history(root, null, session));
    assert.equal(rendered.filter((message) => message.text === "The state is recorded.").length, 2, "Exact-ID reversal must preserve same-text distinct entries");
    const hidden = await session.commit(async (tx) => {
      const items: EntryRecord[] = [];
      for (let index = 0; index < 25; index += 1) items.push(await tx.appendEntry(root.id,
        { kind: "agent.notice", model: [fauxAssistantMessage("Internal receipt " + index)] }));
      return items;
    }, BACKGROUND_CONTEXT);
    await annotateTranscript(session, root, hidden.map((entry) => ({ entry_id: entry.id.toString(), classification: "internal_receipt" })));
    assert.deepEqual(visible(await history(root, null, session)), rendered, "Hidden-only native pages must not conceal older visible history");
    assert.deepEqual((await session.inspect(BACKGROUND_CONTEXT)).tasks, [], "Classification and browsing must not start model work");
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("annotation validation is atomic, conversation-scoped and respects native fork boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-transcript-validation-")), session = await open(directory);
  try {
    const root = await session.root(BACKGROUND_CONTEXT), other = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const first = await session.commit((tx) => tx.appendEntry(root.id, { kind: "agent.notice", model: [fauxAssistantMessage("An existing reply")] }), BACKGROUND_CONTEXT);
    const fork = await root.fork(first.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const later = await session.commit((tx) => tx.appendEntry(root.id, { kind: "agent.notice", model: [fauxAssistantMessage("A later reply")] }), BACKGROUND_CONTEXT);
    const outside = await session.commit((tx) => tx.appendEntry(other.id, { kind: "agent.notice", model: [fauxAssistantMessage("Another conversation")] }), BACKGROUND_CONTEXT);
    for (const id of ["0", "01", "-1", "1.5", "9007199254740992", "not-an-id", outside.id.toString()]) {
      await assert.rejects(annotateTranscript(session, root, [
        { entry_id: first.id.toString(), classification: "internal_receipt" }, { entry_id: id, classification: "maintenance_control" },
      ]));
      assert.equal(await readTranscriptVisibility(session, root.id), undefined, "Rejected batches must not partially classify valid entries");
    }
    await assert.rejects(annotateTranscript(session, root, []));
    await assert.rejects(annotateTranscript(session, root, Array.from({ length: 257 }, () => ({ entry_id: first.id.toString(), classification: "visible" }))));
    await assert.rejects(annotateTranscript(session, root, [
      { entry_id: first.id.toString(), classification: "visible" }, { entry_id: first.id.toString(), classification: "internal_receipt" },
    ]));
    await assert.rejects(annotateTranscript(session, fork, [{ entry_id: later.id.toString(), classification: "internal_receipt" }]));
    await annotateTranscript(session, fork, [{ entry_id: first.id.toString(), classification: "internal_receipt" }]);
    assert.deepEqual(visible(await history(fork, null, session)), []);
    assert.equal(visible(await history(root, null, session)).length, 2, "A fork's classification must not hide its parent's original");
    assert.equal(visible(await history(other, null, session)).length, 1);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("live notice projection honors the same native classification while leaving useful same-text notices visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-transcript-live-")), session = await open(directory);
  let stop = () => {};
  try {
    const root = await session.root(BACKGROUND_CONTEXT), live: string[] = [];
    stop = await watchMainNotices(session, root, (event) => { if (event.type === "message") live.push(event.message.entry_id); });
    const saved = await session.commit(async (tx) => {
      const internal = await tx.appendEntry(root.id, { kind: "agent.user_notice", model: [fauxAssistantMessage("Same native text")] });
      const useful = await tx.appendEntry(root.id, { kind: "agent.user_notice", model: [fauxAssistantMessage("Same native text")] });
      (await tx.doc(TranscriptVisibility, root.id)).entries[internal.id.toString()] = "internal_receipt";
      return { internal, useful };
    }, BACKGROUND_CONTEXT);
    assert.deepEqual(live, [saved.useful.id.toString()]);
    assert.deepEqual(visible(await history(root, null, session)).map((message) => message.entry_id), live);
    stop();
    await annotateTranscript(session, root, [{ entry_id: saved.internal.id.toString(), classification: "visible" }]);
    assert.equal(visible(await history(root, null, session)).length, 2);
    assert.deepEqual(live, [saved.useful.id.toString()], "Changing visibility never replays an old notice as a new live alert");
  } finally { stop(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
