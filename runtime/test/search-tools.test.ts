import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, type ToolCall } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, ToolResultEntry, ToolTask, type Conversation } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { HistoryImportBatch } from "../src/generated/HistoryImportBatch.js";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import type { HistoryGap } from "../src/generated/HistoryGap.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import { HistoryStore, ImportedItemEntry } from "../src/history.js";
import { CodexImporter } from "../src/importer.js";
import { ConversationModels, DEFAULT_MODEL } from "../src/models.js";
import { Retrieval } from "../src/retrieval.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { validEvent } from "../src/protocol.js";

const space: EmbeddingSpace = { id: "synthetic-tool-search", model_revision: "fixture", model_digest: "fixture",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 };
function item(id: string, text: string, order: number): HistoryItem {
  return { id, turn_id: "turn-one", kind: "userMessage", role: "user", text, version: "v1", order,
    timestamp_ms: order, data: { type: "userMessage", text }, assets: [] };
}
function batch(id: string, updated_at: number, items: HistoryItem[]): HistoryImportBatch {
  return { host_id: "fixture-source", thread: { id, title: id, cwd: "/example/project", created_at: 1, updated_at,
    version: "v1", version_reliable: true, archived: true, forked_from_id: null, parent_thread_id: null },
    items, next_cursor: null, gaps: [], complete: true };
}
/** Run registered tools through Pi's durable lifecycle without an inference provider. */
async function invoke(session: Harness, conversation: Conversation, call: ToolCall): Promise<unknown> {
  const id = await conversation.commit(async (tx) => {
    const assistant = await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ role: "assistant", content: [call],
      api: "openai-responses", provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.model_id, stopReason: "toolUse", timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] });
    return tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId: call.id }, { ownership: { kind: "conversation" } });
  }, BACKGROUND_CONTEXT);
  const outcome = (await session.waitForTask(id, BACKGROUND_CONTEXT)).state.outcome;
  assert.equal(outcome.status, "completed");
  if (outcome.status !== "completed" || outcome.result.kind !== "model") throw new Error("Pi did not settle the tool task");
  const entryId = outcome.result.entryId;
  const entry = await conversation.commit((tx) => tx.entry(ToolResultEntry, entryId), BACKGROUND_CONTEXT);
  const message = entry?.model?.[0]; assert.ok(message?.role === "toolResult");
  assert.equal(message.isError, false);
  return JSON.parse(message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
}

test("search and task reads bound imported coverage while Pi retains every canonical diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-import-coverage-"));
  const models = createModels(), registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const history = new HistoryStore(session), tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(history);
  const retrieval = new Retrieval(session, history, tasks, join(directory, "search.sqlite"));
  const executions = new Executions(), tools = createAppTools(tasks, executions); registry.install(tools.main);
  const call: HostCall = async (command) => {
    assert.equal(command.type, "embed", "Coverage reads must not start workers or host effects");
    if (command.type !== "embed") throw new Error("Unexpected host effect");
    return { type: "embeddings", batch: { space, vectors: command.texts.map(() => [1, 0, 0]) } };
  };
  const search = (query: string, refs: string[], limit: number) => retrieval.search(query, refs, limit, call, false);
  const source = batch("retained-connector", 2, [item("decision", "The connector decision needs its original evidence.", 1)]);
  source.complete = false;
  source.gaps = Array.from({ length: 2500 }, (_, index): HistoryGap => ({ code: "missing", item_id: "artifact-" + index,
    message: index === 0 ? "🦀 A synthetic archived artifact is unavailable. ".repeat(100)
      : `Synthetic archived artifact ${index} is unavailable. ` + "The original output must be recovered before relying on it. ".repeat(4) }));
  let closed = false;
  try {
    const receipt = await history.import(source);
    assert.deepEqual(receipt.conversation.gaps, source.gaps);
    await retrieval.sync(call);
    const found = await tasks.find("connector", [], 8, search);
    const frame: RuntimeEvent = { version: 1, id: 1, event: { type: "saved_matches", ...found } };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    assert.ok(bytes < 8000, `Discovery serialized ${bytes} bytes of coverage metadata instead of a bounded summary`);
    assert.ok(validEvent(frame), "The real producer must retain the Rust-owned wire contract");
    const chosen = found.matches.find((match) => match.conversation_id === receipt.conversation.conversation_id);
    assert.ok(chosen?.imported);
    assert.equal(chosen.imported.gap_count, source.gaps.length);
    assert.equal(chosen.imported.complete, false);
    assert.equal(chosen.imported.gaps.length, 3);
    assert.deepEqual(chosen.imported.gaps.map((gap) => gap.item_id), source.gaps.slice(0, 3).map((gap) => gap.item_id));
    assert.ok(chosen.imported.gaps.every((gap) => Array.from(gap.message).length <= 320));
    assert.ok(chosen.imported.gaps[0]?.message.endsWith("…"));
    const root = await session.root(BACKGROUND_CONTEXT);
    const unbind = executions.bind(root.id.toString(), { cwd: "/example/project", hosts: [], call, search });
    try {
      await root.configure({ extensions: [tools.main] }, BACKGROUND_CONTEXT);
      const result = await invoke(session, root, { type: "toolCall", id: "coverage-search", name: "search_tasks", arguments: { query: "connector" } });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8000);
      assert.ok(result !== null && typeof result === "object" && "matches" in result && Array.isArray(result.matches));
      const match: unknown = result.matches.find((value: unknown) => value !== null && typeof value === "object" && "conversation_id" in value && value.conversation_id === chosen.conversation_id);
      assert.ok(match !== null && typeof match === "object" && "imported" in match);
      assert.deepEqual(match.imported, chosen.imported);
      const read = await invoke(session, root, { type: "toolCall", id: "coverage-read", name: "read_task",
        arguments: { conversation_id: chosen.conversation_id, include_history: false } });
      assert.ok(Buffer.byteLength(JSON.stringify(read)) < 8000);
      assert.ok(read !== null && typeof read === "object" && "imported" in read);
      assert.deepEqual(read.imported, chosen.imported);
      assert.equal("history" in read, false);
    } finally { unbind(); }
    assert.deepEqual(await tasks.saved(chosen.conversation_id), receipt.conversation);
    const adopted = await tasks.adopt(chosen.conversation_id, { id: "11111111-1111-4111-8111-111111111111",
      outcome: "Continue the retained decision", evidence: "The original connector decision is retained", model: DEFAULT_MODEL });
    assert.deepEqual((await history.get(source.thread.id))?.gaps, source.gaps);
    await retrieval.close(); await session.close(BACKGROUND_CONTEXT); closed = true;
    const reopened = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
      { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
    try {
      const retained = new HistoryStore(reopened), canonical = await retained.get(source.thread.id);
      assert.deepEqual(canonical?.gaps, source.gaps);
      assert.equal(canonical?.adopted_task_id, adopted.id);
      assert.deepEqual((await retained.checkpoint(source.thread.id, source.host_id))?.gaps, source.gaps);
    } finally { await reopened.close(BACKGROUND_CONTEXT); }
  } finally {
    if (!closed) { await retrieval.close(); await session.close(BACKGROUND_CONTEXT); }
    await rm(directory, { recursive: true, force: true });
  }
});

test("main and worker tools find older substantive context beside a newer shallow candidate and read its selected originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-tools-"));
  const models = createModels();
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const history = new HistoryStore(session); const tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(history);
  const executions = new Executions(), tools = createAppTools(tasks, executions);
  registry.install(tools.main); registry.install(tools.worker);
  const retrieval = new Retrieval(session, history, tasks, join(directory, "search.sqlite"));
  const query = "connector decisions";
  const inspected: string[] = [];
  const decision = item("decision", "DECISION_MARKER Connector decision: use variant Z3 because the measured fit is correct.", 1);
  const verification = item("verification", "VERIFIED_MARKER Connector verification: variant Z3 passed the fit check.", 2);
  const call: HostCall = async (command) => {
    assert.equal(command.type, "embed", "Search and original reads must not allocate workers or run host effects");
    if (command.type !== "embed") throw new Error("Unexpected host effect");
    return { type: "embeddings", batch: { space, vectors: command.texts.map((text) => {
      const cosine = text === query ? 1 : text.includes("SHALLOW_MARKER") ? 0.99 : text.includes("OLD_LOG_MARKER") ? 0.95
        : text.includes("DECISION_MARKER") ? 0.94 : text.includes("VERIFIED_MARKER") ? 0.93 : 0;
      return [cosine, Math.sqrt(1 - cosine * cosine), 0];
    }) } };
  };
  try {
    const old = await history.import(batch("older-substantive", 2, [
      item("long-log", "OLD_LOG_MARKER Connector inspection log. ".repeat(300), 0), decision, verification,
    ]));
    const recent = await history.import(batch("newer-shallow", 1000, [item("new-note", "SHALLOW_MARKER Connector discussion started; no decision recorded.", 0)]));
    const original = await history.conversation(old.conversation.conversation_id); assert.ok(original);
    const entries = (await original.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.filter(ImportedItemEntry.is);
    const ids = entries.map((entry) => entry.id.toString());
    const decisionEntry = entries.find((entry) => entry.data.item.id === decision.id); assert.ok(decisionEntry);
    const worker = await tasks.create({ title: "Retrieval check", outcome: "Inspect retained evidence", model: DEFAULT_MODEL });
    const root = await session.root(BACKGROUND_CONTEXT);
    await retrieval.sync(call);
    for (const role of ["main", "worker"]) {
      const conversation = role === "main" ? root : await tasks.conversation(worker.conversation_id);
      const unbind = executions.bind(conversation.id.toString(), { cwd: "/example/project", hosts: [], call,
        ...(role === "worker" ? { role: "worker" } : {}),
        search: (text, refs, limit, mode) => retrieval.search(text, refs, limit, call, false, mode) });
      try {
        await conversation.configure({ extensions: [role === "main" ? tools.main : tools.worker] }, BACKGROUND_CONTEXT);
        const found = await invoke(session, conversation, { type: "toolCall", id: "original-search-" + role, name: "search_tasks", arguments: { query } });
        assert.ok(found !== null && typeof found === "object" && "matches" in found && Array.isArray(found.matches));
        assert.ok("gaps" in found); assert.deepEqual(found.gaps, []);
        assert.ok(found.matches.some((match: unknown) => match !== null && typeof match === "object" && "conversation_id" in match && match.conversation_id === recent.conversation.conversation_id));
        const position = found.matches.findIndex((match: unknown) => match !== null && typeof match === "object" && "conversation_id" in match && match.conversation_id === old.conversation.conversation_id);
        assert.ok(position > 0, "The fixture must inspect a substantive candidate rather than automatically choosing the first");
        const chosen: unknown = found.matches[position];
        assert.ok(chosen !== null && typeof chosen === "object" && "entry_ids" in chosen && Array.isArray(chosen.entry_ids));
        const selected = chosen.entry_ids.map((id: unknown) => { assert.ok(typeof id === "string"); return id; });
        assert.deepEqual(selected, ids, `${role} must receive distinct original entry IDs despite overlapping log chunks`);
        const read = await invoke(session, conversation, { type: "toolCall", id: "original-read-" + role, name: "read_task",
          arguments: { conversation_id: old.conversation.conversation_id, entry_ids: selected } });
        assert.ok(read !== null && typeof read === "object" && "originals" in read && Array.isArray(read.originals));
        const evidence: unknown = read.originals.find((value: unknown) => value !== null && typeof value === "object" && "entry_id" in value && value.entry_id === decisionEntry.id.toString());
        assert.ok(evidence !== null && typeof evidence === "object" && "data" in evidence && typeof evidence.data === "string");
        assert.deepEqual(JSON.parse(evidence.data), decision.data);
        inspected.push(role);
      } finally { unbind(); }
    }
    assert.deepEqual(inspected, ["main", "worker"]);
    assert.equal((await tasks.list()).length, 1);
    assert.equal((await history.get("older-substantive"))?.adopted_task_id, null);
    assert.equal((await history.get("newer-shallow"))?.adopted_task_id, null);
  } finally { await retrieval.close(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("main and worker search retain fresh matching tasks while an import fills the index results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-live-tasks-"));
  const models = createModels();
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const history = new HistoryStore(session); const tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(history);
  const executions = new Executions(), tools = createAppTools(tasks, executions); registry.install(tools.main); registry.install(tools.worker);
  const retrieval = new Retrieval(session, history, tasks, join(directory, "search.sqlite"));
  const importer = new CodexImporter(session, history, join(directory, "assets"));
  const node: AgentNode = { host_id: "fixture-source", name: "Desktop", rex_server: "https://desktop.example.test", coordinator: null,
    agent_program: "agent", home_directory: "/example/home", launch: { state_dir: null, runtime: null, config: null, instructions: null, model: null } };
  const query = "connector decisions";
  const call: HostCall = async (command) => {
    if (command.type === "embed") return { type: "embeddings", batch: { space, vectors: command.texts.map(() => [1, 0, 0]) } };
    assert.ok(command.type === "on_node" && command.command.type === "history" && command.command.request.type === "list",
      "Import and search must not allocate Rex sessions or run unrelated effects");
    return { type: "history", response: { type: "list", threads: [], next_cursor: null } };
  };
  let release = () => {}, indexed = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { indexed = resolve; });
  let importing: Promise<unknown> | undefined;
  try {
    for (let index = 0; index < 8; index += 1) {
      await history.import(batch(`historical-${index}`, index, [item(`decision-${index}`, `Connector decisions: retain measured variant Z${index}.`, 0)]));
    }
    await retrieval.sync(call);
    const old = await retrieval.search(query, [], 8, call, true); assert.equal(old.candidates.length, 8);
    const fresh = await tasks.create({ title: "Connector decisions", outcome: "Continue the connector decision audit", model: DEFAULT_MODEL });
    const unrelated = await tasks.create({ title: "Unrelated transport repair", outcome: "Fix a bicycle tire", model: DEFAULT_MODEL });
    importing = importer.run([node], [node.host_id], [], call, () => {}, async () => { indexed(); await gate; });
    await began; assert.equal(importer.isRunning(), true);
    const root = await session.root(BACKGROUND_CONTEXT);
    for (const role of ["main", "worker"]) {
      const conversation = role === "main" ? root : await tasks.conversation(fresh.conversation_id);
      const unbind = executions.bind(conversation.id.toString(), { cwd: "/example/project", hosts: [], call,
        ...(role === "worker" ? { role: "worker" } : {}),
        search: (text, refs, limit, mode) => retrieval.search(text, refs, limit, call, importer.isRunning(), mode) });
      try {
        await conversation.configure({ extensions: [role === "main" ? tools.main : tools.worker] }, BACKGROUND_CONTEXT);
        const found = await invoke(session, conversation, { type: "toolCall", id: "fresh-search-" + role, name: "search_tasks", arguments: { query } });
        assert.ok(found !== null && typeof found === "object" && "matches" in found && Array.isArray(found.matches));
        assert.equal(found.matches.length, 8);
        assert.ok(found.matches.some((match: unknown) => match !== null && typeof match === "object" && "task_id" in match && match.task_id === fresh.id),
          `${role}: a full historical index must not hide the fresh matching task`);
        assert.ok(found.matches.some((match: unknown) => match !== null && typeof match === "object" && "entry_ids" in match && Array.isArray(match.entry_ids) && match.entry_ids.length > 0),
          "Historical originals must remain available beside live task metadata");
        assert.ok(found.matches.every((match: unknown) => match !== null && typeof match === "object" && "title" in match && match.title !== "Unrelated transport repair"));
        assert.ok("gaps" in found); assert.deepEqual(found.gaps, ["Codex history import and indexing are in progress"]);
        const exact = await invoke(session, conversation, { type: "toolCall", id: "exact-search-" + role, name: "search_tasks",
          arguments: { query, sources: [{ provider: "task_outcomes", account: "local", thread_id: unrelated.id }] } });
        assert.ok(exact !== null && typeof exact === "object" && "matches" in exact && Array.isArray(exact.matches));
        const first: unknown = exact.matches[0];
        assert.ok(first !== null && typeof first === "object" && "task_id" in first && first.task_id === unrelated.id,
          "An explicit task outcome source must outrank incidental text relevance");
      } finally { unbind(); }
    }
    assert.equal((await tasks.list()).length, 2); assert.equal(importer.isRunning(), true);
  } finally { release(); await importing; await retrieval.close(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});


test("automatic context reads published keyword matches while a native corpus update is held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-snapshot-"));
  const models = createModels();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const history = new HistoryStore(session), tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(history);
  const retrieval = new Retrieval(session, history, tasks, join(directory, "search.sqlite"));
  let release = () => {}, start = () => {}; let held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { start = resolve; });
  const call: HostCall = async (command) => {
    assert.ok(command.type === "embed");
    if (held && command.purpose === "document") { start(); await gate; }
    return { type: "embeddings", batch: { space, vectors: command.texts.map(() => [1, 0, 0]) } };
  };
  let syncing: Promise<void> | undefined;
  try {
    const old = await history.import(batch("published-connector", 1, [item("old", "Connector published decision", 1)]));
    await retrieval.sync(call);
    await history.import(batch("pending-connector", 2, [item("new", "Connector new unpublished decision", 1)]));
    held = true; syncing = retrieval.sync(call); await started;
    const snapshot = await retrieval.snapshot("Connector", [], 8);
    assert.deepEqual(snapshot.candidates.map((candidate) => candidate.conversation_id), [old.conversation.conversation_id]);
    assert.ok(snapshot.gaps.some((gap) => gap.includes("published keyword") && gap.includes("semantic lookup")));
    assert.ok(snapshot.gaps.some((gap) => gap.includes("await indexing")));
    release(); await syncing;
    const complete = await retrieval.search("Connector", [], 8, call, true);
    assert.equal(complete.candidates.length, 2, "Full semantic search retains newly published corpus results");
  } finally { release(); await syncing; await retrieval.close(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("semantic reads after reopen bypass an owned full catchup and retain incremental updates", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-owned-catchup-"));
  const open = async () => {
    const models = createModels();
    const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
      { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
    const history = new HistoryStore(session), tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(history);
    return { session, history, tasks, retrieval: new Retrieval(session, history, tasks, join(directory, "search.sqlite")) };
  };
  const embedding: HostCall = async (command) => {
    assert.ok(command.type === "embed");
    return { type: "embeddings", batch: { space, vectors: command.texts.map((text) => command.purpose === "query" || text.includes("automobile") ? [1, 0, 0] : [0, 1, 0]) } };
  };
  let app = await open(), closed = false;
  let release = () => {}, entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  t.signal.addEventListener("abort", () => release(), { once: true });
  let catchup: Promise<void> | undefined, query: Promise<Awaited<ReturnType<Retrieval["search"]>>> | undefined;
  try {
    const saved = await app.history.import(batch("retained-vehicle", 1, [item("old", "Published automobile specification", 1)]));
    await app.retrieval.sync(embedding);
    await app.history.import(batch("pending-cooking", 2, [item("new", "Unpublished chocolate cake instructions", 1)]));
    await app.retrieval.close(); await app.session.close(BACKGROUND_CONTEXT); closed = true;
    app = await open(); closed = false;
    const owned: HostCall = async (command) => {
      if (command.type === "embed" && command.purpose === "document") { entered(); await held; }
      return embedding(command);
    };
    catchup = app.retrieval.sync(owned, true); await started;
    const read: HostCall = async (command) => { assert.ok(command.type === "embed" && command.purpose === "query", "The query must not take over corpus work"); return embedding(command); };
    query = app.retrieval.search("car wheel repair", [], 8, read, false);
    // The owner remains held until the independent published read has returned.
    const published = await query;
    assert.equal(published.candidates[0]?.conversation_id, saved.conversation.conversation_id, "Dense retrieval must retain vocabulary-mismatch matches");
    assert.ok(published.gaps.length > 0, "In-flight catchup must remain explicit partial coverage");
    release(); await catchup;
    const caughtUp = await app.retrieval.search("car wheel repair", [], 8, embedding, false);
    assert.equal(caughtUp.candidates.length, 2, "The existing owner must still publish its completed catchup");
    assert.deepEqual(caughtUp.gaps, []);
    const conversation = await app.tasks.conversation(saved.conversation.conversation_id);
    await conversation.submit({ type: "write", entry: { kind: "fixture.current", model: [{ role: "user", content: "Current automobile steering context", timestamp: 3 }] } }, BACKGROUND_CONTEXT);
    const current = await app.retrieval.search("car wheel repair", [], 8, embedding, false);
    assert.ok(current.candidates.some((candidate) => candidate.matches.some((match) => match.text === "Current automobile steering context")), "Normal incremental commits must still become searchable");
    await app.history.import(batch("cold-unindexed", 3, [item("cold", "Unindexed sourdough recipe", 1)]));
    await app.retrieval.close(); await app.session.close(BACKGROUND_CONTEXT); closed = true;
    app = await open(); closed = false;
    let documentCalls = 0;
    const cold = await app.retrieval.search("car wheel repair", [], 8, async (command) => {
      if (command.type === "embed" && command.purpose === "document") documentCalls += 1;
      return embedding(command);
    }, false);
    assert.equal(documentCalls, 0, "A cold semantic read must not initiate full inventory reconciliation");
    assert.equal(cold.candidates[0]?.conversation_id, saved.conversation.conversation_id);
    assert.ok(cold.gaps.length > 0, "An unreconciled restart cannot claim complete coverage");
  } finally {
    release(); await Promise.allSettled([catchup, query]);
    if (!closed) { await app.retrieval.close(); await app.session.close(BACKGROUND_CONTEXT); }
    await rm(directory, { recursive: true, force: true });
  }
});
