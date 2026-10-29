import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AgentDoc, createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { AuthError, ChatGptAuth } from "../src/auth.js";
import { ConversationModels, DEFAULT_MODEL, ModelError, PROVIDERS } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import { validEvent } from "../src/protocol.js";
import type { ModelSelection } from "../src/generated/ModelSelection.js";
import type { TaskRecord } from "../src/generated/TaskRecord.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerLaunch } from "../src/generated/WorkerLaunch.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { fixtureModel } from "./model.js";

const host: WorkerHost = { host_id: null, name: "fixture", rex_server: null, coordinator: null, cwd: "/workspace/example", agent_program: "/example/agent" };
const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111",
  session_id: "session:22222222-2222-4222-8222-222222222222", window_id: "window:33333333-3333-4333-8333-333333333333",
  block_id: "block:44444444-4444-4444-8444-444444444444" };
async function open(directory: string, models: MutableModels, auth?: ChatGptAuth) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const inference = new ConversationModels(models, auth);
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(database), { models, registry,
    identity: { attribution: null }, settings: { stream: { transport: "sse", maxRetries: 0 } } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, inference);
  return { session, tasks, inference, registry };
}
function fauxModels() {
  const models = createModels();
  const first = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  const second = fauxProvider({ provider: "anthropic", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  models.setProvider(first.provider); models.setProvider(second.provider);
  return { models, first, second };
}

test("typed providers cover the actual upstream registry and explicit unsupported settings fail before inference", () => {
  const native = builtinModels(); const inference = new ConversationModels(native);
  assert.deepEqual([...PROVIDERS].sort(), native.getProviders().map((provider) => provider.id).sort());
  assert.equal(new Set(PROVIDERS).size, 42);
  assert.throws(() => inference.validate({ ...DEFAULT_MODEL, reasoning: "minimal" }), ModelError);
  assert.throws(() => inference.validate({ ...DEFAULT_MODEL, model_id: "missing-model" }), ModelError);
  assert.throws(() => inference.validate({ provider: "anthropic", model_id: "claude-opus-4-6", reasoning: null, fast: true }), ModelError);
  inference.validate({ ...DEFAULT_MODEL, reasoning: "high", fast: true });
});

test("another provider uses native authentication without reading or creating ChatGPT state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-models-")); const native = fauxModels();
  const app = await open(directory, native.models, new ChatGptAuth(directory));
  try {
    const selected: ModelSelection = { ...fixtureModel, provider: "anthropic" };
    await app.inference.preflight(selected);
    const conversation = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await app.inference.configure(conversation, selected, {});
    native.second.setResponses([fauxAssistantMessage("Native provider works.")]);
    assert.equal((await (await conversation.submit({ type: "input", content: "Check this provider." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(native.second.state.callCount, 1); assert.equal(native.first.state.callCount, 0);
    assert.equal((await readdir(directory)).includes("auth.json"), false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a fresh OpenAI API-key setup works but damaged private state cannot fall back to that key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-models-"));
  let environmentReads = 0;
  const models = builtinModels({ authContext: { env: async (name) => {
    environmentReads += 1; return name === "OPENAI_API_KEY" ? "sk-synthetic" : undefined;
  }, fileExists: async () => false } });
  const inference = new ConversationModels(models, new ChatGptAuth(directory));
  try {
    await inference.preflight(DEFAULT_MODEL); assert.ok(environmentReads > 0);
    await writeFile(join(directory, "auth.json"), '{"version":99}', { mode: 0o600 }); environmentReads = 0;
    await assert.rejects(inference.preflight(DEFAULT_MODEL), (error: unknown) => error instanceof AuthError && error.code === "storage");
    assert.equal(environmentReads, 0);
    assert.equal(await readFile(join(directory, "auth.json"), "utf8"), '{"version":99}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent first use of a dynamic provider shares its native catalog refresh", async () => {
  const native = fauxProvider({ provider: "radius", models: [{ id: "fixture" }] });
  const models = createModels(); let refreshed = false; let fetches = 0;
  let release: () => void = () => {}; let started: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  models.setProvider({ ...native.provider, getModels: () => refreshed ? native.provider.getModels() : [],
    refreshModels: async (context) => {
      if (context.allowNetwork) {
        fetches += 1; started(); await gate;
        await context.publish({ update: () => { refreshed = true; } });
      }
    } });
  const inference = new ConversationModels(models); const selected: ModelSelection = { ...fixtureModel, provider: "radius" };
  const concurrent = Promise.all([inference.preflight(selected), inference.preflight(selected)]);
  void concurrent.catch(() => {});
  try { await fetching; release(); await concurrent; }
  finally { release(); }
  assert.equal(refreshed, true); assert.equal(fetches, 1); assert.equal(native.state.callCount, 0);
});

test("new task selection honors an explicit worker-host override before persisting its model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-models-")); const native = fauxModels(); const app = await open(directory, native.models);
  const executions = new Executions(); const tools = createAppTools(app.tasks, executions); app.registry.install(tools.main);
  const selected: ModelSelection = { ...fixtureModel, provider: "anthropic" };
  const override: WorkerHost = { ...host, launch: { state_dir: null, runtime: null, config: null, instructions: null, model: selected } };
  let release: (() => void) | undefined;
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    release = executions.bind(root.id.toString(), { model: fixtureModel, cwd: host.cwd, hosts: [override],
      call: async () => ({ type: "spawned", binding }) });
    await app.inference.configure(root, fixtureModel, { extensions: [tools.main] });
    native.first.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate_task", { title: "Check component", outcome: "Verify the component", input: "Inspect this component." }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The task is running."),
    ]);
    assert.equal((await (await root.submit({ type: "input", content: "Delegate the component check." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    const tasks = await app.tasks.list(); assert.equal(tasks.length, 1); assert.deepEqual(tasks[0]?.model, selected);
  } finally { release?.(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("tasks and children retain their selected model across reopen and changes to incoming defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-models-")); let native = fauxModels(); let app = await open(directory, native.models);
  try {
    const selected: ModelSelection = { ...fixtureModel, provider: "anthropic" };
    const task = await app.tasks.create({ title: "Preserve its model", outcome: "Finish using the selected backend", model: selected });
    await app.tasks.enqueue(task.id, "Work on the original assignment.");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await app.tasks.get(task.id); if (saved.worker.state !== "bound") throw new Error("No worker binding");
    const command = { type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id, binding,
      instructions: "", cwd: host.cwd, model: fixtureModel } satisfies Extract<import("../src/generated/RuntimeCommand.js").RuntimeCommand, { type: "run_task" }>;
    await app.session.close(BACKGROUND_CONTEXT); native = fauxModels(); app = await open(directory, native.models);
    native.second.setResponses([fauxAssistantMessage("The original backend handled the turn.")]);
    await app.tasks.run(command, (_conversation, _host, model) => { assert.deepEqual(model, selected); return () => {}; }, [], undefined,
      (model) => app.inference.preflight(model));
    assert.equal(native.second.state.callCount, 1); assert.equal(native.first.state.callCount, 0);
    const child = await app.tasks.createAgent(task.id, { id: "fixture-review", title: "Review", outcome: "Check the concrete result",
      input: "Review this work.", inputId: "fixture-child-input" });
    assert.deepEqual(child.model, selected); assert.deepEqual((await app.tasks.get(task.id)).model, selected);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

type LegacyTask = Omit<TaskRecord, "model" | "worker" | "agents"> & { agents: []; worker: { state: "bound"; allocation_id: string;
  binding: WorkerRef; host: Omit<WorkerHost, "launch"> & { launch: Omit<WorkerLaunch, "model"> & { model: string } } } };
const LegacyTasks = defineDoc<{ tasks: LegacyTask[] }>({ kind: "agent.tasks", scope: "session", version: 1,
  initial: () => ({ tasks: [] }), checkpointWhen: () => true });
test("legacy native conversation state wins over old string launch defaults without losing history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-models-")); let native = fauxModels(); let app = await open(directory, native.models);
  try {
    const task = await app.tasks.create({ title: "Legacy work", outcome: "Keep the original conversation" });
    await app.tasks.enqueue(task.id, "Continue the older assignment.");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const current = await app.tasks.get(task.id); if (current.worker.state !== "bound") throw new Error("No old binding");
    const conversation = await app.tasks.conversation(task.conversation_id);
    await conversation.configure({ model: { provider: "anthropic", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    await conversation.submit({ type: "write", entry: { kind: "fixture.legacy", model: [{ role: "user", content: "Original violet connector evidence.", timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
    const { model: _model, worker: _worker, agents: _agents, ...fields } = current;
    await app.session.commit(async (tx) => {
      const document = await tx.doc(LegacyTasks);
      document.tasks = [{ ...fields, agents: [], worker: { ...current.worker, state: "bound", allocation_id: current.worker.state === "bound" ? current.worker.allocation_id : "",
        binding, host: { ...host, launch: { state_dir: null, runtime: null, config: null, instructions: null, model: "fixture" } } } }];
    }, BACKGROUND_CONTEXT);
    await app.session.close(BACKGROUND_CONTEXT); native = fauxModels(); app = await open(directory, native.models);
    const canonical = await app.tasks.get(task.id);
    assert.ok(validEvent({ version: 1, id: 1, event: { type: "tasks", tasks: [canonical] } }));
    native.second.setResponses([fauxAssistantMessage("Continued with the original provider and evidence.")]);
    await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: current.worker.allocation_id, binding,
      instructions: "", cwd: host.cwd, model: fixtureModel }, () => () => {});
    assert.deepEqual((await app.tasks.get(task.id)).model, { ...fixtureModel, provider: "anthropic" });
    assert.match(await app.tasks.history(task.id), /Original violet connector evidence/);
    assert.equal(native.second.state.callCount, 1); assert.equal(native.first.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
type WireRequest = { model: string; tier: string | null; effort: string | null };
function wireRequest(value: unknown): WireRequest {
  assert.ok(object(value)); assert.equal(typeof value.model, "string");
  if (typeof value.model !== "string") throw new Error("Missing native model");
  assert.ok(value.service_tier === undefined || typeof value.service_tier === "string");
  const reasoning = value.reasoning; assert.ok(reasoning === undefined || object(reasoning));
  let effort = object(reasoning) ? reasoning.effort : null;
  // Models with mid-conversation effort put the effective setting in input.
  if (Array.isArray(value.input)) for (const item of value.input) {
    if (object(item) && item.type === "configuration_update" && object(item.reasoning)) effort = item.reasoning.effort;
  }
  assert.ok(effort === null || typeof effort === "string");
  return { model: value.model, tier: typeof value.service_tier === "string" ? value.service_tier : null, effort };
}
function complete(response: ServerResponse): void {
  const item = { type: "message", id: "message_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Verified.", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "response_fixture", object: "response", created_at: 1, status: "in_progress", model: "gpt-6.1-sol", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Verified." },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Verified." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response_fixture", object: "response", created_at: 1, status: "completed", model: "gpt-6.1-sol", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""));
}

test("native HTTP requests keep concurrent conversation fast policies separate and recover them after reopen", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-models-")); const requests: WireRequest[] = []; const waiting: ServerResponse[] = [];
  let failure: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses");
      let body = ""; for await (const chunk of request) body += chunk.toString();
      const parsed: unknown = JSON.parse(body); requests.push(wireRequest(parsed)); waiting.push(response);
      if (requests.length >= 2) for (const pending of waiting.splice(0)) complete(pending);
    })().catch((error: unknown) => { failure = error; response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const catalog = () => {
    const native = openaiProvider(); const original = native.getModels().find((model) => model.id === DEFAULT_MODEL.model_id); assert.ok(original);
    const model = { ...original, baseUrl: `http://127.0.0.1:${address.port}/v1` };
    const models = createModels();
    models.setProvider({ ...native, getModels: () => [model], auth: { apiKey: { name: "Synthetic key", resolve: async () => ({ auth: { apiKey: "sk-synthetic" } }) } } });
    return models;
  };
  let app = await open(directory, catalog());
  try {
    const normal = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const fast = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await app.inference.configure(normal, { ...DEFAULT_MODEL, reasoning: "low", fast: false }, {});
    await app.inference.configure(fast, { ...DEFAULT_MODEL, reasoning: "high", fast: true }, {});
    const submitted = await Promise.all([normal, fast].map((conversation) => conversation.submit({ type: "input", content: "Verify this request." }, BACKGROUND_CONTEXT)));
    const results = await Promise.all(submitted.map((submission) => submission.wait(BACKGROUND_CONTEXT)));
    assert.equal(results.every((result) => result.status === "done"), true);
    if (failure !== undefined) throw failure;
    assert.deepEqual(requests.map((request) => [request.tier, request.effort]).sort(), [[null, "low"], ["priority", "high"]].sort());
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory, catalog());
    const resumed = await app.session.conversation(fast.id, BACKGROUND_CONTEXT); assert.ok(resumed);
    assert.equal((await (await resumed.submit({ type: "input", content: "Continue the saved policy." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(requests[2]?.tier, "priority"); assert.equal(requests[2]?.effort, "high");
    const state = await app.session.snapshot(AgentDoc, fast.id, BACKGROUND_CONTEXT);
    assert.deepEqual(state?.model, { provider: "openai", modelId: DEFAULT_MODEL.model_id });
    if (failure !== undefined) throw failure;
  } finally {
    await app.session.close(BACKGROUND_CONTEXT); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});

test("a model switch during authentication does not rewrite or fail an already chosen request", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-model-change-")), requests: WireRequest[] = [];
  let release = () => {}, entered = () => {}, failure: unknown;
  const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const server = createServer((request, response) => {
    void (async () => {
      let body = ""; for await (const chunk of request) body += chunk.toString();
      requests.push(wireRequest(JSON.parse(body))); complete(response);
    })().catch((error: unknown) => { failure = error; response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const native = openaiProvider(), original = native.getModels().find((model) => model.id === DEFAULT_MODEL.model_id); assert.ok(original);
  const model = { ...original, baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const next = { ...model, id: "fixture-next" };
  const models = createModels(); let resolutions = 0;
  models.setProvider({ ...native, getModels: () => [model, next], auth: { apiKey: { name: "Synthetic key", resolve: async () => {
    resolutions += 1; if (resolutions === 1) { entered(); await held; }
    return { auth: { apiKey: "sk-synthetic" } };
  } } } });
  const app = await open(directory, models);
  try {
    const conversation = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await app.inference.configure(conversation, DEFAULT_MODEL, {});
    const input = await conversation.submit({ type: "input", content: "Finish the existing request" }, BACKGROUND_CONTEXT); await started;
    await app.inference.configure(conversation, { ...DEFAULT_MODEL, model_id: next.id, fast: true }, {});
    release(); assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "done");
    if (failure !== undefined) throw failure;
    assert.equal(requests.length, 1); assert.equal(requests[0]?.model, original.id); assert.equal(requests[0]?.tier, null);
    assert.deepEqual((await app.session.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT))?.model, { provider: "openai", modelId: next.id });
  } finally {
    release(); await app.session.close(BACKGROUND_CONTEXT); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});
