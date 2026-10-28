import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { HistoryImportBatch } from "../src/generated/HistoryImportBatch.js";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import { HistoryStore, ImportedItemEntry } from "../src/history.js";
import { CodexImporter } from "../src/importer.js";
import { ConversationModels } from "../src/models.js";
import { Retrieval } from "../src/retrieval.js";
import { TaskStore, type HostCall } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { fixtureModel } from "./model.js";

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
function lastResult(context: TranscriptContext): unknown {
  const message = context.messages.findLast((message) => message.role === "toolResult");
  assert.ok(message?.role === "toolResult");
  return JSON.parse(message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
}

test("main and worker tools find older substantive context beside a newer shallow candidate and read its selected originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-tools-"));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
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
    const worker = await tasks.create({ title: "Retrieval check", outcome: "Inspect retained evidence", model: fixtureModel });
    const root = await session.root(BACKGROUND_CONTEXT);
    for (const role of ["main", "worker"]) {
      const conversation = role === "main" ? root : await tasks.conversation(worker.conversation_id);
      const unbind = executions.bind(conversation.id.toString(), { cwd: "/example/project", hosts: [], call,
        ...(role === "worker" ? { role: "worker" } : {}),
        search: (text, refs, limit, mode) => retrieval.search(text, refs, limit, call, false, mode) });
      try {
        await tasks.inference.configure(conversation, fixtureModel, { instructions: "Find prior context and inspect its original decisions.", cwd: "/example/project",
          extensions: [role === "main" ? tools.main : tools.worker] });
        let failure: unknown;
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("search_tasks", { query }), { stopReason: "toolUse" }),
          async (context) => {
            try {
              const found = lastResult(context); assert.ok(found !== null && typeof found === "object" && "matches" in found && Array.isArray(found.matches));
              assert.ok("gaps" in found); assert.deepEqual(found.gaps, []);
              assert.ok(found.matches.some((match: unknown) => match !== null && typeof match === "object" && "conversation_id" in match && match.conversation_id === recent.conversation.conversation_id));
              const position = found.matches.findIndex((match: unknown) => match !== null && typeof match === "object" && "conversation_id" in match && match.conversation_id === old.conversation.conversation_id);
              assert.ok(position > 0, "The fixture must inspect a substantive candidate rather than automatically choosing the first");
              const chosen: unknown = found.matches[position];
              assert.ok(chosen !== null && typeof chosen === "object" && "entry_ids" in chosen && Array.isArray(chosen.entry_ids));
              assert.deepEqual(chosen.entry_ids, ids, `${role} must receive distinct original entry IDs despite overlapping log chunks`);
              return fauxAssistantMessage(fauxToolCall("read_task", { conversation_id: old.conversation.conversation_id, entry_ids: chosen.entry_ids }), { stopReason: "toolUse" });
            } catch (error) { failure = error; return fauxAssistantMessage("Fixture assertion failed."); }
          },
          async (context) => {
            try {
              const read = lastResult(context); assert.ok(read !== null && typeof read === "object" && "originals" in read && Array.isArray(read.originals));
              const evidence: unknown = read.originals.find((value: unknown) => value !== null && typeof value === "object" && "entry_id" in value && value.entry_id === decisionEntry.id.toString());
              assert.ok(evidence !== null && typeof evidence === "object" && "data" in evidence && typeof evidence.data === "string");
              assert.deepEqual(JSON.parse(evidence.data), decision.data);
              inspected.push(role);
              return fauxAssistantMessage("The retained decision and verification are available.");
            } catch (error) { failure = error; return fauxAssistantMessage("Fixture assertion failed."); }
          },
        ]);
        const settled = await (await conversation.submit({ type: "input", content: "Inspect the prior decisions." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
        if (failure !== undefined) throw failure;
        assert.ok(settled.type === "input" && settled.status === "done");
      } finally { unbind(); }
    }
    assert.deepEqual(inspected, ["main", "worker"]);
    assert.equal((await tasks.list()).length, 1);
    assert.equal((await history.get("older-substantive"))?.adopted_task_id, null);
    assert.equal((await history.get("newer-shallow"))?.adopted_task_id, null);
  } finally { retrieval.close(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("main and worker search retain fresh matching tasks while an import fills the index results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-search-live-tasks-"));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
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
    const fresh = await tasks.create({ title: "Connector decisions", outcome: "Continue the connector decision audit", model: fixtureModel });
    const unrelated = await tasks.create({ title: "Unrelated transport repair", outcome: "Fix a bicycle tire", model: fixtureModel });
    importing = importer.run([node], [node.host_id], [], call, () => {}, async () => { indexed(); await gate; });
    await began; assert.equal(importer.isRunning(), true);
    const root = await session.root(BACKGROUND_CONTEXT);
    for (const role of ["main", "worker"]) {
      const conversation = role === "main" ? root : await tasks.conversation(fresh.conversation_id);
      const unbind = executions.bind(conversation.id.toString(), { cwd: "/example/project", hosts: [], call,
        ...(role === "worker" ? { role: "worker" } : {}),
        search: (text, refs, limit, mode) => retrieval.search(text, refs, limit, call, importer.isRunning(), mode) });
      try {
        await tasks.inference.configure(conversation, fixtureModel, { instructions: "Find related existing work before continuing it.", cwd: "/example/project",
          extensions: [role === "main" ? tools.main : tools.worker] });
        let failure: unknown;
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("search_tasks", { query }), { stopReason: "toolUse" }),
          async (context) => {
            try {
              const found = lastResult(context); assert.ok(found !== null && typeof found === "object" && "matches" in found && Array.isArray(found.matches));
              assert.equal(found.matches.length, 8);
              assert.ok(found.matches.some((match: unknown) => match !== null && typeof match === "object" && "task_id" in match && match.task_id === fresh.id),
                `${role}: a full historical index must not hide the fresh matching task`);
              assert.ok(found.matches.some((match: unknown) => match !== null && typeof match === "object" && "entry_ids" in match && Array.isArray(match.entry_ids) && match.entry_ids.length > 0),
                "Historical originals must remain available beside live task metadata");
              assert.ok(found.matches.every((match: unknown) => match !== null && typeof match === "object" && "title" in match && match.title !== "Unrelated transport repair"));
              assert.ok("gaps" in found); assert.deepEqual(found.gaps, ["Codex history import and indexing are in progress"]);
            } catch (error) { failure ??= error; }
            return fauxAssistantMessage(fauxToolCall("search_tasks", { query,
              sources: [{ provider: "task_outcomes", account: "local", thread_id: unrelated.id }] }), { stopReason: "toolUse" });
          },
          async (context) => {
            try {
              const found = lastResult(context); assert.ok(found !== null && typeof found === "object" && "matches" in found && Array.isArray(found.matches));
              const first: unknown = found.matches[0];
              assert.ok(first !== null && typeof first === "object" && "task_id" in first && first.task_id === unrelated.id,
                "An explicit task outcome source must outrank incidental text relevance");
            } catch (error) { failure ??= error; }
            return fauxAssistantMessage("Related work is available.");
          },
        ]);
        await (await conversation.submit({ type: "input", content: "Continue the connector decisions." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
        if (failure !== undefined) throw failure;
      } finally { unbind(); }
    }
    assert.equal((await tasks.list()).length, 2); assert.equal(importer.isRunning(), true);
  } finally { release(); await importing; retrieval.close(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
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
  } finally { release(); await syncing; retrieval.close(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
