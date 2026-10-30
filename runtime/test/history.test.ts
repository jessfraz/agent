import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { HistoryStore, ImportedItemEntry, ImportedThreadEntry, importedText } from "../src/history.js";
import { HistoryObservation } from "../src/history-revisions.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { createSourceTools, SourceJournal } from "../src/sources.js";
import { SearchIndex, type Embed } from "../src/search.js";
import { history } from "../src/transcript.js";
import { fixtureModel } from "./model.js";
import type { HistoryImportBatch } from "../src/generated/HistoryImportBatch.js";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import type { HistoryAssetRef } from "../src/generated/HistoryAssetRef.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import type { SearchMode } from "../src/generated/SearchMode.js";

const host: WorkerHost = { host_id: null, name: "fixture", rex_server: null, coordinator: null, cwd: "/workspace/current", agent_program: "/example/agent" };
const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
function item(id: string, text: string, role: HistoryItem["role"] = "user", version = "v1"): HistoryItem {
  return { id, turn_id: "turn-one", kind: role === "user" ? "userMessage" : "agentMessage", role, text, version, order: Number(id.slice(-1)) || 0,
    timestamp_ms: 1, data: { type: role === "user" ? "userMessage" : "agentMessage", text }, assets: [] };
}
function batch(items: HistoryItem[], extra: Partial<HistoryImportBatch> = {}): HistoryImportBatch {
  return { host_id: "host-one", thread: { id: "native-one", title: "Resolve the old quote", cwd: "/old/source/directory", created_at: 1, updated_at: 2,
    version: "thread-v1", version_reliable: true, archived: true, forked_from_id: null, parent_thread_id: null }, items, next_cursor: null, gaps: [], complete: true, ...extra };
}
async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite")); const storage = await SqliteStorage.open(database);
  const models = createModels(); const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const registry = createRegistry();
  const session = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const imported = new HistoryStore(session, join(directory, "assets")); const tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(imported);
  const executions = new Executions(); const tools = createAppTools(tasks, executions);
  registry.install(tools.main); registry.install(tools.worker); registry.install(tools.host);
  return { session, storage, imported, tasks, faux, executions, tools, registry };
}

test("lineage reconciliation changes only a current reliable record and leaves unchanged observations read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-history-lineage-")); const app = await open(directory);
  try {
    const source = batch([item("item1", "Retain the original discussion")]);
    const saved = await app.imported.import(source);
    const conversation = await app.imported.conversation(saved.conversation.conversation_id); assert.ok(conversation);
    const before = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const commit = app.session.commit.bind(app.session); let commits = 0;
    app.session.commit = (change, context) => { commits += 1; return commit(change, context); };
    const observed = { ...source.thread, parent_thread_id: "native-parent", forked_from_id: "native-fork" };
    await app.imported.reconcileLineage({ ...observed, id: "unknown-source" });
    await app.imported.reconcileLineage({ ...observed, version_reliable: false });
    await app.imported.reconcileLineage({ ...observed, version: "different-version" });
    await app.imported.reconcileLineage({ ...observed, updated_at: source.thread.updated_at - 1 });
    await app.imported.reconcileLineage(source.thread);
    assert.equal(commits, 0, "Unchanged and ineligible observations must not rebuild receipts or start a native commit");
    await app.imported.reconcileLineage({ ...observed, title: "A listing preview", cwd: "/another/listing", archived: false });
    assert.equal(commits, 1);
    assert.deepEqual(await app.imported.get(source.thread.id), { ...saved.conversation, thread: { ...source.thread,
      parent_thread_id: observed.parent_thread_id, forked_from_id: observed.forked_from_id } });
    await app.imported.reconcileLineage(observed); assert.equal(commits, 1);
    assert.deepEqual(await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT), before);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a delayed lineage repair preserves concurrent adoption and cannot overwrite newer native observations", async (t) => {
  for (const change of ["adoption", "version", "timestamp"]) await t.test(change, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-history-lineage-race-")); const app = await open(directory);
    let entered = () => {}, release = () => {};
    const began = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    let repair: Promise<void> | undefined;
    try {
      const source = batch([item("item1", "Retain the original discussion")]);
      const imported = await app.imported.import(source), commit = app.session.commit.bind(app.session); let held = false;
      app.session.commit = async (body, context) => {
        if (!held) { held = true; entered(); await gate; }
        return commit(body, context);
      };
      repair = app.imported.reconcileLineage({ ...source.thread, parent_thread_id: "listing-parent", forked_from_id: "listing-fork" });
      await began;
      if (change === "adoption") await app.tasks.adopt(imported.conversation.conversation_id, { id: randomUUID(),
        outcome: "Continue the existing discussion", evidence: "Current adoption context", model: fixtureModel });
      else await app.imported.import({ ...source, thread: { ...source.thread, version: change === "version" ? "newer-v2" : source.thread.version,
        updated_at: source.thread.updated_at + 1, parent_thread_id: "newer-parent", forked_from_id: "newer-fork" } });
      const current = await app.imported.get(source.thread.id); assert.ok(current);
      const conversation = await app.imported.conversation(imported.conversation.conversation_id); assert.ok(conversation);
      const before = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
      release(); await repair;
      assert.deepEqual(await app.imported.get(source.thread.id), change === "adoption" ? { ...current, thread: { ...current.thread,
        parent_thread_id: "listing-parent", forked_from_id: "listing-fork" } } : current);
      assert.deepEqual(await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT), before);
      if (change === "adoption") assert.equal(await app.imported.evidence(imported.conversation.conversation_id), "Current adoption context");
      assert.equal(app.faux.state.callCount, 0);
    } finally { release(); await repair; await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
  });
});

test("legacy oversized previews stay intact as evidence and become bounded titles on reads and adoption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-")); const app = await open(directory);
  try {
    const preview = "Synthetic 🦀 topic\n\t".repeat(20_000);
    const source = batch([item("item1", preview)]); source.thread.title = preview;
    const saved = await app.imported.import(source);
    const expected = Array.from(preview.replace(/\s+/gu, " ").trim()).slice(0, 128).join("");
    assert.equal(saved.conversation.thread.title, expected);
    assert.equal((await app.imported.get(source.thread.id))?.thread.title, expected);
    const conversation = await app.imported.conversation(saved.conversation.conversation_id); assert.ok(conversation);
    const page = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const metadata = page.items.find(ImportedThreadEntry.is); assert.ok(metadata);
    assert.equal(metadata.data.thread.title, preview, "Retained source metadata must not be rewritten");
    assert.equal(importedText(metadata), expected);
    const original = page.items.find(ImportedItemEntry.is); assert.ok(original);
    assert.equal(await app.imported.indexText(original), preview, "The original message remains fully searchable");
    const task = await app.tasks.adopt(saved.conversation.conversation_id, { id: randomUUID(),
      outcome: "Continue the existing conversation", evidence: "Historical topic", model: fixtureModel });
    assert.equal(task.title, expected);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("inert imports deduplicate overlapping hosts, survive page interruption and retain versions without creating tasks or executions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-")); let app = await open(directory);
  try {
    const first = await app.imported.import(batch([item("item1", "The violet capacitor was approved.")], { complete: false, next_cursor: "page-two" }));
    assert.equal((await app.imported.checkpoint("native-one", "host-one"))?.next_cursor, "page-two");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const [left, right] = await Promise.all([
      app.imported.import(batch([item("item1", "The violet capacitor was approved."), item("item2", "Supplier agreed.", "assistant")])),
      app.imported.import(batch([item("item2", "Supplier agreed.", "assistant"), item("item3", "Native tool evidence", "tool")], { host_id: "host-two" })),
    ]);
    assert.equal(left.conversation.conversation_id, first.conversation.conversation_id);
    assert.equal(right.conversation.conversation_id, first.conversation.conversation_id);
    assert.equal(left.added_items + right.added_items, 2);
    const unchanged = await app.imported.import(batch([], { host_id: "host-three", complete: false }));
    assert.equal(unchanged.conversation.complete, true); assert.equal(unchanged.entry_ids.length, 0);
    assert.equal((await app.imported.checkpoint("native-one", "host-one"))?.complete, true);
    const conversation = await app.imported.conversation(first.conversation.conversation_id); assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => ImportedItemEntry.is(entry)).length, 3);
    assert.ok(entries.items.every((entry) => entry.model === undefined));
    assert.deepEqual((await conversation.context(BACKGROUND_CONTEXT)).messages, []);
    assert.equal((await app.session.commit((tx) => tx.scanTasks({}, 100), BACKGROUND_CONTEXT)).items.length, 0);
    assert.deepEqual(await app.tasks.list(), []); assert.equal(app.faux.state.callCount, 0);
    const updated = batch([item("item2", "Supplier revised its agreement.", "assistant", "v2")]);
    updated.thread = { ...updated.thread, version: "thread-v2", updated_at: 3 };
    await app.imported.import(updated);
    const fork = batch([item("item1", "Separate fork")]); fork.thread = { ...fork.thread, id: "native-fork", forked_from_id: "native-one", parent_thread_id: "native-one" };
    const separate = await app.imported.import(fork); assert.notEqual(separate.conversation.conversation_id, first.conversation.conversation_id);
    assert.equal(separate.conversation.thread.forked_from_id, "native-one");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal((await app.imported.import(updated)).added_items, 0);
    assert.equal((await app.imported.get("native-one"))?.conversation_id, first.conversation.conversation_id);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("failed native commit cannot publish a conversation mapping or item receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-atomic-")); let app = await open(directory);
  try {
    const commit = app.storage.commit.bind(app.storage); let fail = true;
    app.storage.commit = async (writes, context) => { if (fail && writes.some((write) => write.type === "entry")) { fail = false; throw new Error("Injected commit failure"); } return commit(writes, context); };
    await assert.rejects(app.imported.import(batch([item("item1", "Retain one original")])), /Injected commit failure/);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal(await app.imported.get("native-one"), undefined);
    const result = await app.imported.import(batch([item("item1", "Retain one original")]));
    assert.equal(result.added_items, 1); assert.equal((await app.imported.import(batch([item("item1", "Retain one original")]))).added_items, 0);
    assert.equal((await app.tasks.list()).length, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an unreliable same-version observation retains items without claiming a failed reread is complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-unreliable-")); const app = await open(directory);
  try {
    const initial = batch([item("item1", "Retain this known item")]); initial.thread.version_reliable = false;
    const first = await app.imported.import(initial); assert.equal(first.conversation.complete, true);
    const failed = await app.imported.import({ ...initial, items: [], complete: false, gaps: [{ code: "unavailable", item_id: null, message: "Native source read failed" }] });
    assert.equal(failed.conversation.conversation_id, first.conversation.conversation_id); assert.equal(failed.conversation.complete, false);
    assert.equal((await app.imported.checkpoint(initial.thread.id, initial.host_id))?.complete, false);
    assert.deepEqual((await app.imported.checkpoint(initial.thread.id, initial.host_id))?.gaps, failed.conversation.gaps);
    const recovered = await app.imported.import(initial); assert.equal(recovered.added_items, 0); assert.equal(recovered.conversation.complete, true);
    assert.deepEqual((await app.imported.checkpoint(initial.thread.id, initial.host_id))?.gaps, []);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a changed same-second source version checkpoints its unfinished page across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-same-second-")); let app = await open(directory);
  try {
    const initial = batch([item("item1", "First revision")]); await app.imported.import(initial);
    const changed = { ...initial, thread: { ...initial.thread, version: "thread-v2" }, items: [item("item2", "New first page")],
      complete: false, next_cursor: "second-page", gaps: [{ code: "missing", item_id: "item3", message: "A retained asset is unavailable" }] } satisfies HistoryImportBatch;
    const imported = await app.imported.import(changed); assert.equal(imported.conversation.complete, false);
    assert.equal(imported.conversation.thread.version, "thread-v2");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const checkpoint = await app.imported.checkpoint(initial.thread.id, initial.host_id);
    assert.equal(checkpoint?.version, "thread-v2"); assert.equal(checkpoint?.next_cursor, "second-page");
    assert.deepEqual(checkpoint?.gaps, changed.gaps); assert.equal((await app.imported.import(changed)).added_items, 0);
    assert.equal((await app.imported.import({ ...changed, next_cursor: null, complete: true, gaps: [] })).conversation.complete, true);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("retained cold originals remain readable offline and full user text is available to indexing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-assets-")); const app = await open(directory);
  try {
    const root = join(directory, "assets"); await mkdir(root);
    const text = "Earlier context. ".repeat(3000) + "The late detail is a zirconium connector.";
    const bytes = Buffer.from(JSON.stringify({ type: "userMessage", content: [{ type: "text", text }] }));
    const digest = createHash("sha256").update(bytes).digest("hex"); const path = join(root, digest); await writeFile(path, bytes, { mode: 0o600 });
    const original = item("item1", "Earlier context."); original.data = null;
    original.assets = [{ path, item_id: original.id, version: original.version, kind: "cold_evidence", media_type: "application/json", sha256: digest, size: bytes.length }];
    const result = await app.imported.import(batch([original]));
    const records = []; for await (const record of app.tasks.records(result.conversation.conversation_id)) records.push(record);
    assert.ok(records.some((record) => record.text.includes("late detail is a zirconium connector")));
    const entry = result.entry_ids.at(-1); assert.ok(entry); let offset: number | null = 0; let retained = "";
    while (offset !== null) {
      const page: { data: string; next_offset: number | null } | undefined = (await app.tasks.originals(result.conversation.conversation_id, [entry], offset))[0]; assert.ok(page);
      retained += page.data; offset = page.next_offset;
    }
    assert.deepEqual(JSON.parse(retained), JSON.parse(bytes.toString("utf8")));
    await assert.rejects(app.tasks.originals("another-conversation", [entry]), /does not belong/);
    await assert.rejects(app.tasks.originals(result.conversation.conversation_id, [entry], bytes.length + 1), /byte boundary/);
    assert.deepEqual(await readFile(path), bytes);
    const foreign = item("item2", "External locator"); foreign.assets = [{ ...original.assets[0]!, path: join(directory, "source-only") }];
    await writeFile(foreign.assets[0]!.path, bytes);
    await assert.rejects(app.imported.import(batch([foreign])), /outside coordinator storage/);
    assert.equal((await app.imported.import(batch([original]))).added_items, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("media-only evidence versions alias one immutable message and survive reopen without repeating text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-history-evidence-alias-")); let app = await open(directory);
  try {
    const original = item("item1", "Keep this instruction while its image is unavailable.");
    original.data = { type: "userMessage", content: [{ type: "text", text: original.text }, { type: "image", path: "/source/illustration.png" }] };
    const initial = await app.imported.import(batch([original], { complete: false,
      gaps: [{ code: "missing", item_id: original.id, message: "A referenced media asset is unavailable" }] }));
    const conversation = await app.imported.conversation(initial.conversation.conversation_id); assert.ok(conversation);
    const before = (await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items.find(ImportedItemEntry.is); assert.ok(before);
    const assets = join(directory, "assets"); await mkdir(assets);
    const bytes = Buffer.from("synthetic media"), sha256 = createHash("sha256").update(bytes).digest("hex"), path = join(assets, sha256); await writeFile(path, bytes);
    const available = { ...original, version: "v2", assets: [{ path, sha256, size: bytes.length, kind: "local_media", media_type: "image/png",
      item_id: original.id, version: "v2" } satisfies HistoryAssetRef] };
    const recovered = await app.imported.import(batch([available]));
    assert.equal(recovered.added_items, 0, "A changed media evidence version must not append the same message again");
    assert.equal(recovered.existing_items, 1); assert.notEqual(recovered.watermark, initial.watermark);
    assert.deepEqual((await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items.filter(ImportedItemEntry.is), [before]);
    const projected = await app.imported.entry(initial.conversation.conversation_id, before.id.toString()); assert.ok(ImportedItemEntry.is(projected));
    assert.deepEqual(projected.data.item.assets, available.assets, "Retained refs must preserve the actual new evidence version");
    const repeated = await app.imported.import(batch([available])); assert.deepEqual(repeated.entry_ids, []); assert.equal(repeated.watermark, recovered.watermark);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const reopened = await app.imported.import(batch([available])); assert.deepEqual(reopened.entry_ids, []); assert.equal(reopened.watermark, recovered.watermark);
    const saved = await app.imported.conversation(initial.conversation.conversation_id); assert.ok(saved);
    assert.deepEqual((await history(saved, null, app.session)).flatMap((frame) => frame.messages).filter((message) => message.role === "user").map((message) => message.text), [original.text]);
    const records = []; for await (const record of app.tasks.records(saved.id.toString())) records.push(record);
    assert.equal(records.filter((record) => record.text === original.text).length, 1); assert.equal(app.faux.state.callCount, 0);
    const edited = { ...available, version: "v3", data: { type: "userMessage", text: original.text + " A distinct raw suffix." } };
    assert.equal((await app.imported.import(batch([edited]))).added_items, 1, "Matching excerpts cannot hide a full-payload edit");
    assert.equal((await app.imported.import(batch([{ ...available, version: "v4", timestamp_ms: 2 }]))).added_items, 1,
      "Changed native context remains a distinct item version");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("duplicate source receipts within one batch still create exactly one canonical message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-history-duplicate-receipt-")); const app = await open(directory);
  try {
    const original = item("item1", "Retain an overlapping native page once");
    const saved = await app.imported.import(batch([original, original]));
    assert.equal(saved.added_items, 1); assert.equal(saved.existing_items, 1);
    const conversation = await app.imported.conversation(saved.conversation.conversation_id); assert.ok(conversation);
    assert.equal((await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items.filter(ImportedItemEntry.is).length, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("missing and ambiguous full originals remain distinct even when saved excerpts match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-history-unknown-original-")); const app = await open(directory);
  try {
    const original = item("item1", "The same bounded excerpt"); const full = { type: "userMessage", text: original.text + " Original full suffix." };
    original.data = null;
    const first = await app.imported.import(batch([original], { complete: false }));
    const known = { ...original, version: "v2", data: full };
    assert.equal((await app.imported.import(batch([known]))).added_items, 1, "An unavailable full original cannot prove a media-only change");
    assert.equal((await app.imported.import(batch([{ ...known, version: "v3" }]))).added_items, 1,
      "An unreadable candidate still makes the otherwise matching identity ambiguous");
    const assets = join(directory, "assets"); await mkdir(assets);
    const bytes = Buffer.from(JSON.stringify(full)), sha256 = createHash("sha256").update(bytes).digest("hex"), path = join(assets, sha256); await writeFile(path, bytes);
    await app.imported.import(batch([{ ...original, assets: [{ path, sha256, size: bytes.length, kind: "cold_evidence", media_type: "application/json",
      item_id: original.id, version: original.version }] }]));
    assert.equal((await app.imported.import(batch([{ ...known, version: "v4" }]))).added_items, 1,
      "Multiple matching full originals cannot select an arbitrary canonical message");
    const conversation = await app.imported.conversation(first.conversation.conversation_id); assert.ok(conversation);
    assert.equal((await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items.filter(ImportedItemEntry.is).length, 4);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("verified assets merge across same-version host retries while complete repeats preserve the search watermark", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-asset-recovery-")); let app = await open(directory);
  try {
    const assets = join(directory, "assets"); await mkdir(assets);
    const refs: HistoryAssetRef[] = [];
    for (const name of ["first", "second"]) {
      const bytes = Buffer.from(name), digest = createHash("sha256").update(bytes).digest("hex"), path = join(assets, digest);
      await writeFile(path, bytes);
      refs.push({ path, item_id: "item1", version: "v1", kind: "local_media", media_type: "image/png", sha256: digest, size: bytes.length });
    }
    const first = refs[0], second = refs[1]; assert.ok(first && second);
    const original = item("item1", "Keep the insulation instruction while media recovers."); original.assets = [first];
    const incomplete = batch([original], { complete: false, gaps: [{ code: "unavailable", item_id: original.id, message: "Some advertised media is unavailable" }] });
    const initial = await app.imported.import(incomplete);
    const conversation = await app.imported.conversation(initial.conversation.conversation_id); assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    const retained = entries.items.find(ImportedItemEntry.is); assert.ok(retained);
    const unchanged = await app.imported.import(incomplete);
    assert.deepEqual(unchanged.entry_ids, []); assert.equal(unchanged.watermark, initial.watermark);
    const recovered = await app.imported.import({ ...incomplete, host_id: "host-two", items: [{ ...original, assets: [second] }] });
    assert.equal(recovered.added_items, 0); assert.notEqual(recovered.watermark, initial.watermark);
    const complete = { ...incomplete, host_id: "host-three", items: [{ ...original, assets: refs }], complete: true, gaps: [] };
    const finished = await app.imported.import(complete);
    assert.equal(finished.added_items, 0); assert.equal(finished.entry_ids.length, 1);
    const observation = await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
    assert.ok(observation.items[0] && HistoryObservation.is(observation.items[0]));
    assert.equal(observation.items[0].data.snapshot?.host_id, "host-three");
    assert.notEqual(finished.watermark, recovered.watermark, "A newly observing host retains causal provenance without repeating the message");
    const repeated = await app.imported.import(complete);
    assert.deepEqual(repeated.entry_ids, []); assert.equal(repeated.watermark, finished.watermark);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const result = (await app.tasks.originals(initial.conversation.conversation_id, [retained.id.toString()]))[0]; assert.ok(result);
    assert.deepEqual(result.assets, refs);
    const reopened = await app.imported.conversation(initial.conversation.conversation_id); assert.ok(reopened);
    assert.deepEqual((await reopened.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items.filter(ImportedItemEntry.is), [retained]);
    assert.deepEqual((await history(reopened, null, app.session)).flatMap((frame) => frame.messages).filter((message) => message.role === "user").map((message) => message.text), [original.text]);
    const records = []; for await (const record of app.tasks.records(initial.conversation.conversation_id)) records.push(record);
    assert.equal(records.filter((record) => record.text === original.text).length, 1); assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("generated images retain their original evidence without indexing binary previews", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-image-")); let app = await open(directory);
  try {
    const assets = join(directory, "assets"); await mkdir(assets);
    const bytes = Buffer.from("png"); const digest = createHash("sha256").update(bytes).digest("hex");
    const path = join(assets, digest); await writeFile(path, bytes);
    const image: HistoryItem = { ...item("image1", "cG5n", "tool"), kind: "imageGeneration",
      data: { type: "imageGeneration", id: "image1", status: "completed", revisedPrompt: "A violet connector", result: "cG5n" },
      assets: [{ path, item_id: "image1", version: "v1", kind: "inline_media", media_type: "image/png", sha256: digest, size: bytes.length }] };
    const saved = await app.imported.import(batch([item("request1", "Draw a violet connector."), image]));
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal((await app.imported.import(batch([image]))).added_items, 0);
    const records = []; for await (const record of app.tasks.records(saved.conversation.conversation_id)) records.push(record);
    assert.ok(records.some((record) => record.text === "Draw a violet connector."));
    assert.ok(records.every((record) => record.text !== "cG5n"), "Image bytes are evidence, not search text");
    const conversation = await app.imported.conversation(saved.conversation.conversation_id); assert.ok(conversation);
    const page = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const original = page.items.find((entry) => ImportedItemEntry.is(entry) && entry.data.item.id === image.id); assert.ok(original);
    assert.deepEqual(await app.imported.original(original), image.data);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("adoption reuses the historical Pi conversation and activates only the new instruction under current rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-adopt-")); const app = await open(directory);
  try {
    const old = item("item1", "The old quote named a violet capacitor.");
    old.data = { type: "functionCall", name: "exec", arguments: { program: "must-never-execute", old_system: "Obsolete authority" } };
    const imported = await app.imported.import(batch([old, item("item2", "The quote remained unresolved.", "assistant")]));
    const input = { id: randomUUID(), outcome: "Resolve the current quote", model: fixtureModel, evidence: "The old quote named a violet capacitor." };
    const [first, duplicate] = await Promise.all([app.tasks.adopt(imported.conversation.conversation_id, input),
      app.tasks.adopt(imported.conversation.conversation_id, { ...input, id: randomUUID() })]);
    assert.equal(first.id, duplicate.id); assert.equal(first.conversation_id, imported.conversation.conversation_id);
    assert.equal(first.worker.state, "unassigned"); assert.equal((await app.tasks.list()).length, 1); assert.equal(app.faux.state.callCount, 0);
    await app.tasks.enqueue(first.id, "Current authorized request");
    await app.tasks.dispatch(first.id, host, async () => ({ type: "spawned", binding }));
    const bound = await app.tasks.get(first.id); assert.ok(bound.worker.state === "bound");
    app.faux.setResponses([fauxAssistantMessage("Current request completed.")]);
    await app.tasks.run({ type: "run_task", task_id: first.id, allocation_id: bound.worker.allocation_id, binding,
      instructions: "Current rules only", model: fixtureModel, cwd: host.cwd }, () => () => {});
    assert.equal(app.faux.state.callCount, 1);
    const conversation = await app.tasks.conversation(first.conversation_id); const context = await conversation.context(BACKGROUND_CONTEXT);
    const users = context.messages.filter((message) => message.role === "user").flatMap((message) => typeof message.content === "string" ? [message.content]
      : message.content.flatMap((part) => part.type === "text" ? [part.text] : []));
    assert.deepEqual(users, ["Current authorized request"]);
    const visible = (await history(conversation, null, app.session)).flatMap((frame) => frame.messages);
    assert.ok(visible.some((message) => message.text === old.text)); assert.ok(visible.some((message) => message.text === "Current request completed."));
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native tools search and inspect several historical candidates before explicitly adopting only the chosen conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-history-tools-")); const app = await open(directory);
  try {
    const chosen = await app.imported.import(batch([item("item1", "Supplier approved the violet component.")]));
    const otherBatch = batch([item("item1", "Another unresolved violet component quote.")]); otherBatch.thread.id = "native-two";
    const other = await app.imported.import(otherBatch); const entry = chosen.entry_ids.at(-1); assert.ok(entry);
    const root = await app.session.root(BACKGROUND_CONTEXT); let creates = 0; let resumes = 0; let queries = 0;
    const modes: SearchMode[] = [];
    const candidates = [chosen, other].map((result) => ({ conversation_id: result.conversation.conversation_id, score: 1,
      matches: [{ entry_id: result.entry_ids.at(-1)!, text: "Related historical quote", source_refs: [] }] }));
    const unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], model: fixtureModel,
      async search(_query, _refs, _limit, mode = "semantic") { queries += 1; modes.push(mode); return { candidates, gaps: [] }; }, async call(command) {
        if (command.type === "spawn_worker") { creates += 1; return { type: "spawned", binding }; }
        assert.equal(command.type, "resume_worker"); resumes += 1; return { type: "written" };
      } });
    const lastResult = (context: TranscriptContext): unknown => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.ok(result?.role === "toolResult"); const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      return JSON.parse(text);
    };
    await app.tasks.inference.configure(root, fixtureModel, { instructions: "Use current instructions and inspect historical evidence", cwd: host.cwd, extensions: [app.tools.main] });
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("search_tasks", { query: "Continue the approved part quote", mode: "keyword" }), { stopReason: "toolUse" }),
      async (context) => {
        const result = lastResult(context); assert.ok(result !== null && typeof result === "object" && "matches" in result && Array.isArray(result.matches));
        assert.equal(result.matches.length, 2); assert.deepEqual(await app.tasks.list(), []); assert.equal(creates, 0);
        return fauxAssistantMessage(fauxToolCall("read_task", { conversation_id: chosen.conversation.conversation_id, entry_ids: [entry] }), { stopReason: "toolUse" });
      },
      async (context) => {
        const result = lastResult(context); assert.ok(result !== null && typeof result === "object" && "originals" in result && Array.isArray(result.originals));
        const original: unknown = result.originals[0]; assert.ok(original !== null && typeof original === "object" && "data" in original && typeof original.data === "string");
        assert.deepEqual(JSON.parse(original.data), { type: "userMessage", text: "Supplier approved the violet component." });
        return fauxAssistantMessage(fauxToolCall("delegate_task", { input: "Continue the approved quote" }), { stopReason: "toolUse" });
      },
      async (context) => {
        const result = lastResult(context); assert.ok(result !== null && typeof result === "object" && "related_conversations" in result);
        assert.equal(creates, 0); assert.deepEqual(await app.tasks.list(), []);
        return fauxAssistantMessage(fauxToolCall("delegate_task", { conversation_id: chosen.conversation.conversation_id, input: "Continue the approved quote" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Continued the selected historical quote."),
      fauxAssistantMessage(fauxToolCall("delegate_task", { conversation_id: chosen.conversation.conversation_id, input: "Check the same quote again" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The existing task has the follow-up."),
    ]);
    await (await root.submit({ type: "input", content: "Continue the related quote" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const task = (await app.tasks.list())[0]; assert.ok(task); assert.equal(task.conversation_id, chosen.conversation.conversation_id);
    assert.equal(creates, 1); assert.equal(queries, 3); assert.equal((await app.imported.get("native-two"))?.adopted_task_id, null);
    assert.deepEqual(modes, ["keyword", "semantic", "semantic"]);
    await (await root.submit({ type: "input", content: "And check the same one again" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(creates, 1); assert.equal(resumes, 1); assert.equal((await app.tasks.list()).length, 1);
    assert.deepEqual(modes, ["keyword", "semantic", "semantic"], "An explicit task ID needs no additional search");
    assert.equal((await app.tasks.get(task.id)).pending.length, 2); unbind();
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("live indexing includes full visible text while excluding system instructions, reasoning and notice metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-live-history-index-")); const app = await open(directory);
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    const visible = "Useful context. ".repeat(3000) + "The late fact is a cobalt connector.";
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "fixture.live-index", model: [
      { role: "system", content: "Instructions must never be search evidence", timestamp: 1 },
      { role: "user", content: visible, timestamp: 2 },
      fauxAssistantMessage([fauxThinking("Provider thinking must not be search evidence"), { type: "text", text: "A visible reply" }]),
    ] }), BACKGROUND_CONTEXT);
    const records = []; for await (const record of app.tasks.records(root.id.toString())) records.push(record);
    assert.equal(records.length, 1); assert.ok(records[0]?.text.endsWith("cobalt connector.\nA visible reply"));
    assert.equal(records[0]?.text.includes("Instructions must never"), false); assert.equal(records[0]?.text.includes("Provider thinking"), false);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native source-triage and unknown conversations stay out of search while human histories remain searchable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-human-history-index-")); const app = await open(directory);
  const index = new SearchIndex(":memory:");
  try {
    const sources = new SourceJournal(app.session, app.tasks, app.executions);
    const sourceTools = createSourceTools(sources, app.executions); app.registry.install(sourceTools.main);
    await sources.admit({ source: { provider: "mail", account: "synthetic" }, checkpoint: { value: "one" }, coverage: { status: "complete" },
      events: [{ id: "routine", version: "one", source: { provider: "mail", account: "synthetic", thread_id: "routine" },
        title: "Internal feed signal", text: "noisequantum internal-only source payload. ".repeat(500) }] }, null);
    const keys = (await sources.events({ pending: true })).map((event) => event.key);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dismiss_source_events", { keys, reason: "No action is needed" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Internal triage finished without a user notice."),
    ]);
    let internal = "";
    await sources.triage({ type: "triage_sources", instructions: "Keep internal processing quiet", model: fixtureModel, cwd: host.cwd, hosts: [] },
      (conversation) => {
        internal = conversation.id.toString();
        return app.executions.bind(internal, { role: "triage", cwd: host.cwd, hosts: [], call: async () => { throw new Error("No host effect expected"); } });
      }, [sourceTools.main]);
    assert.notEqual(internal, "");
    const internalRecords = []; for await (const record of app.tasks.records(internal)) internalRecords.push(record);
    assert.equal(internalRecords.length, 0, "Automatic source work is not a human conversation or continuation target");
    const unknown = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    const task = await app.tasks.create({ title: "Human task", outcome: "Retain human work", model: fixtureModel });
    const child = await app.tasks.createAgent(task.id, { id: "review", title: "Human review", outcome: "Review the human task", input: "Review", inputId: "review", model: fixtureModel });
    for (const [conversation, text] of [[root, "lapisroot visible human request"],
      [await app.tasks.conversation(task.conversation_id), "topaztask visible task request"],
      [await app.tasks.conversation(child.conversation_id), "sapphirereview visible agent evidence"],
      [unknown, "noiseunknown internal processing"]] satisfies Array<[import("@earendil-works/pi-durable").Conversation, string]>) {
      await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "fixture.visible", model: [{ role: "user", content: text, timestamp: 1 }] }), BACKGROUND_CONTEXT);
    }
    const full = "Retained historical context. ".repeat(1000) + "zirconiumhistory late detail";
    const original = item("item1", full.slice(0, 16_000)); original.data = { type: "userMessage", text: full };
    const imported = await app.imported.import(batch([original])); const embedded: string[] = [];
    const embed: Embed = async (texts, purpose) => {
      if (purpose === "document") embedded.push(...texts);
      return { space: { id: "synthetic", model_revision: "one", model_digest: "synthetic", dimensions: 3,
        pooling: "last", normalization: "l2", instruction_version: 1 }, vectors: texts.map(() => [1, 0, 0]) };
    };
    await index.reconcile(app.imported.inventory(), (id) => app.tasks.records(id), embed);
    assert.equal(embedded.some((text) => text.includes("noisequantum") || text.includes("noiseunknown")), false);
    for (const [query, id] of [["lapisroot", root.id.toString()], ["topaztask", task.conversation_id],
      ["sapphirereview", child.conversation_id], ["zirconiumhistory", imported.conversation.conversation_id]] satisfies Array<[string, string]>) {
      const result = await index.search(query, embed, [], 8);
      assert.ok(result.candidates.some((candidate) => candidate.conversation_id === id && candidate.matches.some((match) => match.text.includes(query))));
      assert.equal(result.candidates.some((candidate) => candidate.conversation_id === internal || candidate.conversation_id === unknown.id.toString()), false);
    }
  } finally { index.close(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
