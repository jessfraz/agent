import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { BackgroundScheduler } from "../src/background.js";
import { BrowserStore, createBrowserTools } from "../src/browser.js";
import { createGuidance } from "../src/guidance.js";
import { ConversationModels } from "../src/models.js";
import { createResourceTools, ResourceStore } from "../src/resources.js";
import { createSourceTools, SourceJournal } from "../src/sources.js";
import { TaskStore } from "../src/tasks.js";
import { createToolsets, type ToolRole } from "../src/toolsets.js";
import { createAppTools, createJobTools, Executions } from "../src/tools.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { fixtureModel } from "./model.js";

const host: WorkerHost = { host_id: "11111111-1111-4111-8111-111111111111", name: "fixture", rex_server: null,
  coordinator: null, cwd: "/workspace/example", agent_program: "/example/agent" };
const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111",
  session_id: "session:22222222-2222-4222-8222-222222222222", window_id: "window:33333333-3333-4333-8333-333333333333",
  block_id: "block:44444444-4444-4444-8444-444444444444" };
const taskNames = ["search_tasks", "read_task", "revoke_allocation", "delegate_task", "record_task", "continue_agent", "spawn_agent", "read_agents", "wait_agents", "report_result"];
const sourceDecisions = ["link_source_events", "dismiss_source_events", "notify"];
function offered(input: Context, role: ToolRole): void {
  const names = getCurrentTools(input.messages).map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "A shared tool must be offered only once");
  const expected = role === "main" || role === "triage"
    ? ["search_tasks", "read_task", "revoke_allocation", "delegate_task", "record_task"]
    : role === "worker" ? ["record_task", "search_tasks", "read_task", "continue_agent", "spawn_agent", "read_agents", "wait_agents"]
    : ["search_tasks", "read_task", "read_agents", "report_result"];
  assert.deepEqual(names.filter((name) => taskNames.includes(name)).sort(), expected.sort());
  assert.ok(["exec", "read_file", "browser_status", "read_source_events"].every((name) => names.includes(name)));
  assert.deepEqual(names.filter((name) => sourceDecisions.includes(name)).sort(), role === "main" || role === "triage" ? [...sourceDecisions].sort() : []);
  assert.equal(names.includes("read_resources"), role !== "triage");
  assert.equal(names.includes("collect_worktrees"), role === "main");
  assert.equal(names.includes("allocate_worktree"), role === "worker" || role === "agent");
  assert.equal(names.includes("list_jobs"), role === "main" || role === "triage");
}
function toolResult(input: Context, name: string): string {
  const result = input.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
  assert.ok(result?.role === "toolResult", `Missing result from ${name}`); assert.equal(result.isError, false);
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function open(directory: string, guidanceText = "CURRENT_PROFILE_GUIDANCE") {
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))), {
    models, registry, identity: { attribution: null }, settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, BACKGROUND_CONTEXT);
  const inference = new ConversationModels(models), tasks = new TaskStore(session, inference), executions = new Executions();
  const sources = new SourceJournal(session, tasks, executions), resources = new ResourceStore(session, tasks); tasks.guardResources(resources);
  const tools = createAppTools(tasks, executions), sourceTools = createSourceTools(sources, executions);
  const background = new BackgroundScheduler(session, registry, tasks, {
    async plan() { throw new Error("No timer is started by this fixture"); }, async refreshSources() {}, async triageSources() {}, async collectResources() {},
    async runJob() { throw new Error("No scheduled execution is requested by this fixture"); },
  });
  const toolsets = createToolsets({ guidance: createGuidance(executions), tools, sourceTools,
    resourceTools: createResourceTools(resources, tasks, executions), browserTools: createBrowserTools(new BrowserStore(session), executions),
    jobTools: createJobTools(background, executions) });
  for (const extension of new Set(Object.values(toolsets).flat())) registry.install(extension);
  registry.install(tools.legacy);
  const notices: string[] = [];
  const call = async (command: HostCommand): Promise<HostResult> => {
    if (command.type === "reload_guidance") return { type: "shared_guidance", global: { text: guidanceText, sources: [] },
      workflow_policy: "", context_repositories: [], context_sources: [] };
    if (command.type === "project_guidance") return { type: "project_guidance", snapshot: { text: "", sources: [] } };
    if (command.type === "resource_allocate") return { type: "resource", report: { type: "observed", record: {
      id: command.request.allocation_id, host_id: command.request.host_id, task_id: command.request.task_id,
      repository: command.request.repository, branch: command.request.branch, consumers: [command.request.task_id],
      state: { state: "ready", identity: { primary: command.request.repository, top: "/workspace/example-review",
        common_dir: "/workspace/example/.git", git_dir: "/workspace/example/.git/worktrees/review", branch: command.request.branch, head: "synthetic-head" } },
    } } };
    throw new Error(`Unexpected fixture host operation: ${command.type}`);
  };
  const bind = (conversation: Conversation, role?: "worker" | "triage") => executions.bind(conversation.id.toString(), {
    cwd: host.cwd, hosts: [host], ...(role === undefined ? {} : { role }), call, notify: (_task, text) => { notices.push(text); },
  });
  async function prepare(): Promise<Extract<RuntimeCommand, { type: "run_task" }>> {
    const task = await tasks.create({ title: "Profile transition", outcome: "Finish the owned work", model: fixtureModel });
    await tasks.enqueue(task.id, "Continue the parent task."); await tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await tasks.get(task.id); assert.equal(saved.worker.state, "bound"); if (saved.worker.state !== "bound") throw new Error("Missing parent binding");
    return { type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id, binding, instructions: "", model: fixtureModel, cwd: host.cwd };
  }
  const run = (command: Extract<RuntimeCommand, { type: "run_task" }>) => tasks.run(command, (conversation) => bind(conversation, "worker"), command.agent_id === undefined ? toolsets.worker : toolsets.agent);
  return { session, registry, tasks, inference, sources, resources, toolsets, tools, faux, bind, prepare, run, notices };
}

test("the main profile exposes usable inventory and explicit compact or full task reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-toolsets-")), app = await open(directory);
  let release = () => {};
  try {
    const task = await app.tasks.create({ title: "Read this task", outcome: "Inspect its evidence", model: fixtureModel });
    const conversation = await app.tasks.conversation(task.conversation_id);
    await conversation.submit({ type: "write", entry: { kind: "fixture.evidence", model: [{ role: "user", content: "ORIGINAL_TASK_EVIDENCE", timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
    const root = await app.session.root(BACKGROUND_CONTEXT); release = app.bind(root);
    await app.inference.configure(root, fixtureModel, { extensions: app.toolsets.main });
    app.faux.setResponses([
      (input) => {
        offered(input, "main");
        return fauxAssistantMessage([fauxToolCall("read_resources", {}), fauxToolCall("list_jobs", {}),
          fauxToolCall("read_source_events", {}), fauxToolCall("read_task", { task_id: task.id, include_history: false })], { stopReason: "toolUse" });
      },
      (input) => {
        for (const name of ["read_resources", "list_jobs", "read_source_events"]) assert.equal(toolResult(input, name), "[]");
        const compact: unknown = JSON.parse(toolResult(input, "read_task")); assert.ok(object(compact));
        assert.equal("history" in compact, false); assert.equal(JSON.stringify(compact).includes("ORIGINAL_TASK_EVIDENCE"), false);
        return fauxAssistantMessage(fauxToolCall("read_task", { task_id: task.id, include_history: true }), { stopReason: "toolUse" });
      },
      (input) => { assert.match(toolResult(input, "read_task"), /ORIGINAL_TASK_EVIDENCE/); return fauxAssistantMessage("Read the selected evidence."); },
    ]);
    assert.equal((await (await root.submit({ type: "input", content: "Read the task state, then its history." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
  } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a checkpointed legacy task read resumes with its original history and submission identity", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-toolsets-recovery-")); let app = await open(directory);
  let release = () => {};
  try {
    const task = await app.tasks.create({ title: "Saved evidence", outcome: "Retain the original task", model: fixtureModel });
    const evidence = await app.tasks.conversation(task.conversation_id);
    await evidence.submit({ type: "write", entry: { kind: "fixture.evidence", model: [{ role: "user", content: "LEGACY_ORIGINAL_HISTORY", timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
    let entered = (_call: { taskId: string; callId: string }) => {};
    const started = new Promise<{ taskId: string; callId: string }>((resolve) => { entered = resolve; });
    // This producer represents the old schema. Pi records execute intent before
    // this cancellation-aware pause; no legacy implementation is copied here.
    app.registry.install(defineExtension({ name: "task-main", tools: [defineTool({ name: "read_task", replay: "safe",
      description: "Read the selected task's original history.", parameters: Type.Object({ task_id: Type.String() }),
      async execute(args, api, context) {
        assert.deepEqual(args, { task_id: task.id });
        entered({ taskId: api.taskId.toString(), callId: api.callId });
        return await awaitWithContext(new Promise<never>(() => {}), context);
      },
    })] }));
    let root = await app.session.root(BACKGROUND_CONTEXT); release = app.bind(root);
    await app.inference.configure(root, fixtureModel, { extensions: app.toolsets.main });
    app.faux.setResponses([fauxAssistantMessage(fauxToolCall("read_task", { task_id: task.id }), { stopReason: "toolUse" })]);
    const requestText = "Read this task's original evidence once.";
    const submission = await root.submit({ type: "input", content: requestText, requestId: "legacy-history-request" }, BACKGROUND_CONTEXT);
    const originalId = submission.id, call = await started;
    const intent = (await app.session.inspect(BACKGROUND_CONTEXT)).tasks.find((item) => item.record.id.toString() === call.taskId);
    assert.ok(intent?.record.state.status === "running");
    assert.deepEqual(intent.record.state.checkpoint, { phase: "execute", arguments: { task_id: task.id }, replay: "safe" });
    assert.equal(app.faux.state.callCount, 1);
    await app.session.close(BACKGROUND_CONTEXT); release(); app = await open(directory);
    const retained = (await app.session.inspect(BACKGROUND_CONTEXT)).tasks.find((item) => item.record.id.toString() === call.taskId);
    assert.ok(retained?.record.state.status === "running" || retained?.record.state.status === "pending");
    assert.deepEqual(retained.record.state.checkpoint, { phase: "execute", arguments: { task_id: task.id }, replay: "safe" });
    root = await app.session.root(BACKGROUND_CONTEXT); release = app.bind(root);
    app.faux.setResponses([(input) => {
      const result = input.messages.find((message) => message.role === "toolResult" && message.toolCallId === call.callId);
      assert.ok(result?.role === "toolResult"); assert.equal(result.isError, false);
      const body = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      assert.ok(body.includes(task.id)); assert.match(body, /LEGACY_ORIGINAL_HISTORY/);
      return fauxAssistantMessage("The original history survived the update.");
    }]);
    const resumed = await app.session.submission(originalId, BACKGROUND_CONTEXT); assert.ok(resumed);
    assert.equal(resumed.id.toString(), originalId.toString()); assert.equal((await resumed.wait(BACKGROUND_CONTEXT)).status, "done");
    const context = await root.context(BACKGROUND_CONTEXT);
    assert.equal(context.messages.filter((message) => message.role === "user" && (typeof message.content === "string"
      ? message.content === requestText : message.content.some((part) => part.type === "text" && part.text === requestText))).length, 1);
    const calls = context.messages.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "toolCall" && part.name === "read_task" ? [part] : []) : []);
    assert.equal(calls.length, 1); assert.equal(calls[0]?.id, call.callId);
    assert.equal(context.messages.filter((message) => message.role === "toolResult" && message.toolCallId === call.callId).length, 1);
    assert.equal(app.faux.state.callCount, 1, "Reopen runs only the response after the saved tool call");
    assert.equal((await app.tasks.get(task.id)).conversation_id, task.conversation_id);
  } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("triage uses the production profile to decide sources and publish without task-owned resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-toolsets-")), app = await open(directory);
  try {
    await app.sources.admit({ source: { provider: "mail", account: "fixture" }, checkpoint: null, coverage: { status: "complete" },
      events: [{ id: "original", version: "one", source: { provider: "mail", account: "fixture", thread_id: "thread" }, title: "Review evidence", text: "The original source remains available." }] }, null);
    const event = (await app.sources.events({ pending: true }))[0]; assert.ok(event);
    app.faux.setResponses([
      (input) => {
        offered(input, "triage");
        return fauxAssistantMessage([fauxToolCall("read_source_events", { keys: [event.key] }),
          fauxToolCall("dismiss_source_events", { keys: [event.key], reason: "The requested check is complete." })], { stopReason: "toolUse" });
      },
      (input) => {
        assert.match(toolResult(input, "read_source_events"), /The original source remains available/);
        toolResult(input, "dismiss_source_events");
        return fauxAssistantMessage(fauxToolCall("notify", { keys: [event.key], text: "The requested source review is complete." }), { stopReason: "toolUse" });
      },
      (input) => { toolResult(input, "notify"); return fauxAssistantMessage("Source judgment recorded."); },
    ]);
    await app.sources.triage({ type: "triage_sources", instructions: "", model: fixtureModel, cwd: host.cwd, hosts: [host] },
      (conversation) => app.bind(conversation, "triage"), app.toolsets.triage);
    assert.deepEqual(app.notices, ["The requested source review is complete."]);
    assert.equal((await app.sources.events({ keys: [event.key] }))[0]?.decision?.type, "dismissed");
    assert.equal(await app.sources.hasWork(), false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("parent and reopened child profiles retain usable resources, agent reads and child result reporting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-toolsets-")); let app = await open(directory, "GUIDANCE_BEFORE_REOPEN");
  try {
    const command = await app.prepare();
    app.faux.setResponses([
      (input) => { offered(input, "worker"); return fauxAssistantMessage(fauxToolCall("allocate_worktree", { repository: "/workspace/example", branch: "review" }), { stopReason: "toolUse" }); },
      (input) => { toolResult(input, "allocate_worktree"); return fauxAssistantMessage([fauxToolCall("read_resources", {}), fauxToolCall("read_agents", {})], { stopReason: "toolUse" }); },
      (input) => { assert.match(toolResult(input, "read_resources"), /example-review/); assert.equal(toolResult(input, "read_agents"), "[]"); return fauxAssistantMessage("The parent owns its worktree."); },
    ]);
    await app.run(command); assert.equal((await app.resources.list()).length, 1);
    const child = await app.tasks.createAgent(command.task_id, { id: "bounded-review", title: "Review", outcome: "Check the evidence", input: "Finish the pending child assignment.", inputId: "pending-child-input" });
    const childBinding = { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" };
    await app.tasks.dispatchAgent(command.task_id, child.id, async () => ({ type: "spawned", binding: childBinding }));
    const saved = (await app.tasks.get(command.task_id)).agents[0]; assert.ok(saved?.worker.state === "bound");
    const childCommand = { ...command, agent_id: child.id, allocation_id: saved.worker.allocation_id, binding: childBinding };
    const conversation = await app.tasks.conversation(child.conversation_id);
    // Persist the original extension name with an actual pending child input.
    await app.inference.configure(conversation, fixtureModel, { extensions: app.toolsets.agent.map((extension) => extension === app.tools.agent ? app.tools.legacy : extension) });
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory, "GUIDANCE_AFTER_REOPEN");
    assert.equal((await app.tasks.get(command.task_id)).agents[0]?.pending[0]?.id, "pending-child-input");
    app.faux.setResponses([
      (input) => {
        offered(input, "agent"); assert.match(getCurrentSystemPrompt(input.messages), /GUIDANCE_AFTER_REOPEN/);
        assert.doesNotMatch(getCurrentSystemPrompt(input.messages), /GUIDANCE_BEFORE_REOPEN/);
        return fauxAssistantMessage(fauxToolCall("read_agents", {}), { stopReason: "toolUse" });
      },
      (input) => { assert.match(toolResult(input, "read_agents"), /bounded-review/); return fauxAssistantMessage(fauxToolCall("report_result", { summary: "The pending child reviewed the original evidence." }), { stopReason: "toolUse" }); },
      (input) => { toolResult(input, "report_result"); return fauxAssistantMessage("Bounded review complete."); },
    ]);
    await app.run(childCommand);
    const retained = await app.tasks.get(command.task_id);
    assert.equal(retained.state.state, "open"); assert.equal(retained.agents[0]?.state.state, "done");
    assert.equal(retained.agents[0]?.summary, "The pending child reviewed the original evidence.");
    assert.equal(retained.agents[0]?.pending.length, 0); assert.equal(retained.agents[0]?.conversation_id, child.conversation_id);
    assert.equal((await app.resources.list()).length, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
