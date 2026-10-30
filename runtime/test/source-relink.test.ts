import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type JsonObject } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";
import type { SourceEvent } from "../src/generated/SourceEvent.js";
import { HistoryStore } from "../src/history.js";
import { ConversationModels } from "../src/models.js";
import { Retrieval } from "../src/retrieval.js";
import { createSourceTools, SourceJournal } from "../src/sources.js";
import { sourceReference, TaskStore, type HostCall } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { fixtureModel } from "./model.js";

const space: EmbeddingSpace = { id: "source-relink", model_revision: "fixture", model_digest: "fixture",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 };
function event(version: string, account = "alpha"): SourceEvent {
  return { id: "message", version, source: { provider: "mail", account, thread_id: "thread-one" },
    title: "A source message", text: "The original source evidence " + version };
}
async function open(directory: string) {
  const models = createModels();
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const histories = new HistoryStore(session), tasks = new TaskStore(session, new ConversationModels(models)); tasks.useHistory(histories);
  const sources = new SourceJournal(session, tasks), retrieval = new Retrieval(session, histories, tasks, join(directory, "search.sqlite"));
  const close = async () => { await retrieval.close(); await session.close(BACKGROUND_CONTEXT); };
  const entries = async (id: string) => (await (await tasks.conversation(id)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
  const evidence = async (id: string, text: string) => (await tasks.conversation(id)).submit({ type: "write", entry: {
    kind: "fixture.evidence", model: [{ role: "user", content: text, timestamp: 1 }],
  } }, BACKGROUND_CONTEXT);
  const admit = async (events: SourceEvent[]) => {
    const first = events[0]; assert.ok(first);
    await sources.admit({ source: { provider: first.source.provider, account: first.source.account }, events,
      checkpoint: null, coverage: { status: "complete" } }, null);
    const saved = await sources.events({ limit: 100 });
    return events.map((item) => { const found = saved.find((record) => record.event.version === item.version &&
      record.event.source.account === item.source.account); assert.ok(found); return found.key; });
  };
  return { session, models, registry, tasks, sources, retrieval, entries, evidence, admit, close };
}

test("correcting settled source links refreshes parent and child search provenance across reopen without losing evidence or reembedding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-relink-")); let app = await open(directory);
  let embedded = 0;
  const call: HostCall = async (command) => {
    assert.equal(command.type, "embed", "A source correction must not allocate or execute workers");
    if (command.type !== "embed") throw new Error("Unexpected host effect");
    if (command.purpose === "document") embedded += command.texts.length;
    return { type: "embeddings", batch: { space, vectors: command.texts.map(() => [1, 0, 0]) } };
  };
  try {
    const old = await app.tasks.create({ title: "Unrelated work", outcome: "Retain prior evidence", model: fixtureModel });
    const correct = await app.tasks.create({ title: "Relevant work", outcome: "Continue the actual request", model: fixtureModel });
    const child = await app.tasks.createAgent(old.id, { id: "child", title: "Existing child", outcome: "Retain child evidence",
      input: "Read the evidence", inputId: "child-input", model: fixtureModel });
    await app.evidence(old.conversation_id, "Oldamethyst original unrelated request.");
    await app.evidence(child.conversation_id, "Childcobalt original child observation.");
    await app.evidence(correct.conversation_id, "Correctvermilion the actual request.");
    const source = event("v1"), [key] = await app.admit([source]); assert.ok(key);
    await app.sources.decide([key], { type: "task", task_id: old.id });
    await app.retrieval.sync(call);
    const before = await app.entries(old.conversation_id), childBefore = await app.entries(child.conversation_id);
    const initial = await app.retrieval.search("", [sourceReference(source.source)], 8, call, false, "keyword");
    assert.deepEqual(new Set(initial.candidates.map((candidate) => candidate.conversation_id)), new Set([old.conversation_id, child.conversation_id]));
    const embeddings = embedded;
    await app.close(); app = await open(directory);
    await app.sources.decide([key], { type: "task", task_id: correct.id });
    assert.deepEqual((await app.tasks.get(old.id)).sources, [], "A corrected decision must release the wrong task's current source routing");
    assert.deepEqual((await app.tasks.get(correct.id)).sources, [source.source]);
    const pending = await app.tasks.find("", [source.source], 8,
      (query, refs, limit) => app.retrieval.snapshot(query, refs, limit), "keyword");
    assert.equal(pending.matches[0]?.conversation_id, correct.conversation_id,
      "Current routing must outrank stale published source references while index catchup is pending");
    await app.close(); app = await open(directory);
    await app.retrieval.sync(call, true);
    const result = await app.tasks.find("", [source.source], 8,
      (query, refs, limit, mode) => app.retrieval.search(query, refs, limit, call, false, mode), "keyword");
    assert.deepEqual(result.matches.map((match) => match.conversation_id), [correct.conversation_id],
      "Restart catchup must remove both parent and child published exact-source matches");
    const oldResults = await app.retrieval.snapshot("oldamethyst childcobalt", [], 8);
    assert.equal(oldResults.candidates.length, 2);
    assert.ok(oldResults.candidates.every((candidate) => candidate.matches.every((match) => !match.source_refs.includes(sourceReference(source.source)))));
    assert.equal(embedded, embeddings, "Changing routing must reuse the existing text vectors");
    const after = await app.entries(old.conversation_id), childAfter = await app.entries(child.conversation_id);
    assert.deepEqual(after.slice(0, before.length), before, "Historical provenance remains immutable");
    assert.deepEqual(childAfter.slice(0, childBefore.length), childBefore);
    assert.ok(after.length > before.length && childAfter.length > childBefore.length, "Native tails must durably record the correction for index catchup");
    assert.ok(after.slice(before.length).every((entry) => entry.model === undefined), "Routing receipts must stay out of model context");
    const retained = await app.sources.events({ keys: [key] });
    assert.deepEqual(retained[0]?.event, source); assert.deepEqual(retained[0]?.decision, { type: "task", task_id: correct.id });
    const tails = await Promise.all([old.conversation_id, child.conversation_id, correct.conversation_id].map(app.entries));
    await app.sources.decide([key], { type: "task", task_id: correct.id });
    assert.deepEqual(await Promise.all([old.conversation_id, child.conversation_id, correct.conversation_id].map(app.entries)), tails,
      "Repeating the settled correction must not append more receipts");
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a failed affected conversation rolls back decisions, source ownership and already-staged routing receipts together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-relink-")); let app = await open(directory);
  try {
    const old = await app.tasks.create({ title: "Original", outcome: "Keep the original routing", model: fixtureModel });
    const target = await app.tasks.create({ title: "New", outcome: "Correct the routing" });
    const child = await app.tasks.createAgent(old.id, { id: "child", title: "Child", outcome: "Keep prior evidence",
      input: "Read the evidence", inputId: "child-input", model: fixtureModel });
    const [key] = await app.admit([event("v1")]); assert.ok(key);
    await app.sources.decide([key], { type: "task", task_id: old.id });
    await app.tasks.update(old.id, (task) => { task.agents[0]!.conversation_id = "invalid-native-id"; });
    const tasksBefore = await app.tasks.list(), eventsBefore = await app.sources.events({ limit: 100 });
    const ids = [old.conversation_id, child.conversation_id, target.conversation_id];
    const entriesBefore = await Promise.all(ids.map(app.entries));
    await assert.rejects(app.sources.decide([key], { type: "task", task_id: target.id }), /Task conversation is unavailable/);
    await app.close(); app = await open(directory);
    assert.deepEqual(await app.tasks.list(), tasksBefore);
    assert.deepEqual(await app.sources.events({ limit: 100 }), eventsBefore);
    assert.deepEqual(await Promise.all(ids.map(app.entries)), entriesBefore, "Even receipts staged before the failed child must remain uncommitted");
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("public task updates can remove a verified legacy link without sweeping ambiguous references or another linked version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-relink-")); let app = await open(directory), unbind = () => {};
  const call: HostCall = async (command) => {
    assert.equal(command.type, "embed"); if (command.type !== "embed") throw new Error("Unexpected host effect");
    return { type: "embeddings", batch: { space, vectors: command.texts.map(() => [1, 0, 0]) } };
  };
  try {
    const manual = { provider: "calendar", account: "alpha", thread_id: "unrelated" };
    const old = await app.tasks.create({ title: "Old work", outcome: "Keep legitimate context", sources: [manual] });
    const correct = await app.tasks.create({ title: "Correct work", outcome: "Resume the actual original" });
    await app.evidence(old.conversation_id, "Old original evidence."); await app.evidence(correct.conversation_id, "Correct original evidence.");
    const source = event("v1"), [v1, v2] = await app.admit([source, event("v2")]); assert.ok(v1 && v2);
    await app.sources.decide([v1], { type: "task", task_id: old.id });
    await app.sources.decide([v2], { type: "task", task_id: correct.id });
    const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); app.models.setProvider(faux.provider);
    const executions = new Executions(), tools = createAppTools(app.tasks, executions), sourceTools = createSourceTools(app.sources, executions);
    app.registry.install(tools.main); app.registry.install(sourceTools.main);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    unbind = executions.bind(root.id.toString(), { cwd: "/example/project", hosts: [], call });
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools.main, sourceTools.main] }, BACKGROUND_CONTEXT);
    const invoke = async (name: string, args: JsonObject) => {
      faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }), fauxAssistantMessage("")]);
      const submission = await root.submit({ type: "input", content: "Apply the verified source correction." }, BACKGROUND_CONTEXT);
      assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
      const result = (await root.context(BACKGROUND_CONTEXT)).messages.findLast((message) => message.role === "toolResult");
      assert.ok(result?.role === "toolResult");
      return { failed: result.isError, text: result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") };
    };
    const update = { task_id: old.id, summary: "Verified stale source association", state: { state: "open" }, remove_sources: [source.source] };
    const blocked = await invoke("record_task", update);
    assert.equal(blocked.failed, true); assert.match(blocked.text, /every source event\/version/);
    assert.equal((await app.tasks.get(old.id)).summary, "");
    const overlap = await invoke("record_task", { ...update, sources: [source.source] });
    assert.equal(overlap.failed, true); assert.match(overlap.text, /separate source references/);
    await app.sources.decide([v1], { type: "task", task_id: correct.id });
    // The pre-fix journal overwrote decisions while leaving this exact legacy
    // association. Its previous ownership is now indistinguishable from a manual link.
    await app.tasks.update(old.id, (task) => { task.sources.push(source.source); });
    const repeated = await invoke("link_source_events", { keys: [v1, v2], task_id: correct.id });
    assert.equal(repeated.failed, false);
    const warning: unknown = JSON.parse(repeated.text);
    assert.ok(warning !== null && typeof warning === "object" && "unverified_source_links" in warning);
    assert.deepEqual(warning.unverified_source_links, [{ task_id: old.id, source: source.source }]);
    assert.deepEqual((await app.tasks.get(old.id)).sources, [manual, source.source], "A retry must disclose rather than guess legacy/manual ownership");
    await app.retrieval.sync(call);
    const originals = await app.entries(old.conversation_id);
    const removed = await invoke("record_task", update); assert.equal(removed.failed, false);
    assert.deepEqual((await app.tasks.get(old.id)).sources, [manual]);
    await app.retrieval.sync(call);
    const found = await app.retrieval.search("", [sourceReference(source.source)], 8, call, false, "keyword");
    assert.deepEqual(found.candidates.map((candidate) => candidate.conversation_id), [correct.conversation_id]);
    assert.deepEqual((await app.entries(old.conversation_id)).slice(0, originals.length), originals);
    unbind(); await app.close(); app = await open(directory);
    assert.deepEqual((await app.tasks.get(old.id)).sources, [manual]);
    assert.deepEqual((await app.tasks.get(correct.id)).sources, [source.source]);
    assert.deepEqual((await app.sources.events({ keys: [v1, v2] })).map((record) => record.decision),
      [{ type: "task", task_id: correct.id }, { type: "task", task_id: correct.id }]);
  } finally { unbind(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("relink and dismissal preserve other source versions and accounts while concurrent decisions and failures remain atomic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-relink-")); let app = await open(directory);
  try {
    const manual = { provider: "calendar", account: "alpha", thread_id: "unrelated" };
    const old = await app.tasks.create({ title: "Original", outcome: "Keep legitimate links", sources: [manual] });
    const target = await app.tasks.create({ title: "Corrected", outcome: "Continue related work" });
    const other = await app.tasks.create({ title: "Another correction", outcome: "Continue the final selection" });
    const first = event("v1"), second = event("v2"), beta = event("v1", "beta");
    const [v1, v2] = await app.admit([first, second]), [betaKey] = await app.admit([beta]); assert.ok(v1 && v2 && betaKey);
    await app.sources.decide([v1, v2, betaKey], { type: "task", task_id: old.id });
    await app.sources.decide([v2], { type: "task", task_id: target.id });
    assert.deepEqual((await app.tasks.get(old.id)).sources, [manual, first.source, beta.source], "Another linked version still owns the original thread association");
    const tasksBefore = await app.tasks.list(), eventsBefore = await app.sources.events({ limit: 100 });
    const entriesBefore = await Promise.all(tasksBefore.map((task) => app.entries(task.conversation_id)));
    await assert.rejects(app.sources.decide([v1], { type: "task", task_id: "missing-task" }), /Unknown task/);
    await assert.rejects(app.sources.decide([v1, "missing-event"], { type: "task", task_id: target.id }), /Unknown source event/);
    assert.deepEqual(await app.tasks.list(), tasksBefore); assert.deepEqual(await app.sources.events({ limit: 100 }), eventsBefore);
    assert.deepEqual(await Promise.all(tasksBefore.map((task) => app.entries(task.conversation_id))), entriesBefore);
    await app.sources.decide([v1], { type: "task", task_id: target.id });
    assert.deepEqual((await app.tasks.get(old.id)).sources, [manual, beta.source], "Moving the last linked version releases only that exact source");
    await app.sources.decide([betaKey], { type: "dismissed", reason: "The event belongs to no unfinished work" });
    assert.deepEqual((await app.tasks.get(old.id)).sources, [manual]);
    await Promise.all([app.sources.decide([v1, v2], { type: "task", task_id: old.id }),
      app.sources.decide([v1, v2], { type: "task", task_id: other.id })]);
    await app.close(); app = await open(directory);
    const decisions = await app.sources.events({ keys: [v1, v2] });
    const winner = decisions[0]?.decision; assert.ok(winner?.type === "task");
    assert.ok(decisions.every((record) => record.decision?.type === "task" && record.decision.task_id === winner.task_id));
    for (const task of await app.tasks.list()) assert.equal(task.sources.some((source) => sourceReference(source) === sourceReference(first.source)), task.id === winner.task_id,
      "Only the current owner may keep the corrected exact-source routing");
    assert.deepEqual((await app.tasks.get(old.id)).sources.filter((source) => source.provider === "calendar"), [manual]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
