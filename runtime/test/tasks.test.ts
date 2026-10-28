import { fixtureModel } from "./model.js";
import { ConversationModels } from "../src/models.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions, HostRequests } from "../src/tools.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { ModelActivity } from "../src/generated/ModelActivity.js";
import { activity, history } from "../src/transcript.js";

const host: WorkerHost = { host_id: null, name: "fixture", rex_server: null, coordinator: null,
  cwd: "/workspace/example", agent_program: "/example/agent" };
const binding: WorkerRef = {
  host_id: "11111111-1111-4111-8111-111111111111",
  session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333",
  block_id: "block:44444444-4444-4444-8444-444444444444",
};

test("interrupt drains the current native turn before admitting queued steering in the same interactive actor", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-interrupt-")); const app = await open(directory);
  const controller = new AbortController(); let running: Promise<unknown> | undefined; let release = () => {};
  try {
    const task = await app.tasks.create({ title: "Steer work", outcome: "Finish the corrected request" });
    await app.tasks.enqueue(task.id, "Start the old direction");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await app.tasks.get(task.id); assert.ok(saved.worker.state === "bound");
    const command: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id,
      binding, instructions: "Current rules", model: fixtureModel, cwd: host.cwd, interactive: true };
    let started = () => {}; const startedTurn = new Promise<void>((resolve) => { started = resolve; });
    const drain = new Promise<void>((resolve) => { release = resolve; }); let abortSeen = () => {};
    const aborted = new Promise<void>((resolve) => { abortSeen = resolve; });
    app.faux.setResponses([async (_context, options) => {
      const signal = options?.signal; assert.ok(signal); started();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      abortSeen(); await drain; return fauxAssistantMessage("Discarded old direction");
    }, fauxAssistantMessage("Corrected direction completed")]);
    const conversation = await app.tasks.conversation(task.conversation_id); const answers: string[] = [];
    let idle = () => {}; const idleTurn = new Promise<void>((resolve) => { idle = resolve; });
    let interrupt: Promise<void> | undefined;
    running = app.tasks.run(command, () => () => {}, () => {}, [], undefined, undefined, {
      signal: controller.signal, async ready() {}, answer(_id, value) { answers.push(value); }, idle() { idle(); },
      beforeTurn() { return interrupt ?? Promise.resolve(); },
    });
    await startedTurn;
    interrupt = (async () => { await conversation.abort(BACKGROUND_CONTEXT); })();
    await aborted;
    await app.tasks.input(command, "Use the corrected direction instead", "steering");
    assert.equal(app.tasks.isRunning(task.id), true, "Interrupted work stays guarded until native cancellation drains");
    assert.equal(app.faux.state.callCount, 1);
    release(); await interrupt; await idleTurn;
    assert.deepEqual(answers, ["Corrected direction completed"]); assert.equal(app.faux.state.callCount, 2);
    const idleAgain = new Promise<void>((resolve) => { idle = resolve; });
    let restarted = () => {}; const nextStarted = new Promise<void>((resolve) => { restarted = resolve; });
    app.faux.setResponses([async (_context, options) => {
      const signal = options?.signal; assert.ok(signal); restarted();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return fauxAssistantMessage("Discarded second direction");
    }, fauxAssistantMessage("Second correction completed")]);
    await app.tasks.input(command, "Start another direction", "second-direction"); await nextStarted;
    interrupt = (async () => { await conversation.abort(BACKGROUND_CONTEXT); })();
    await app.tasks.input(command, "Correct that direction too", "second-steering"); await interrupt; await idleAgain;
    assert.deepEqual(answers, ["Corrected direction completed", "Second correction completed"]); assert.equal(app.faux.state.callCount, 4);
    assert.deepEqual((await app.tasks.get(task.id)).pending, []);
    const visible = (await history(conversation, null)).flatMap((frame) => frame.messages);
    assert.deepEqual(visible.filter((message) => message.role === "user").map((message) => message.text),
      ["Start the old direction", "Use the corrected direction instead", "Start another direction", "Correct that direction too"]);
    assert.equal(visible.some((message) => message.text === "Discarded old direction"), false);
    assert.equal(visible.some((message) => message.text === "Discarded second direction"), false);
    controller.abort(); await running; running = undefined;
    assert.equal((await app.tasks.get(task.id)).conversation_id, task.conversation_id);
  } finally { release(); controller.abort(); await running?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("confirmed session loss fences the old actor before reopening the same history and preserves child assignments", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-session-reopen-")); const app = await open(directory);
  const controller = new AbortController(); let running: Promise<unknown> | undefined; let release = () => {};
  try {
    const task = await app.tasks.create({ title: "Continue closed work", outcome: "Finish the same task", model: fixtureModel });
    await app.tasks.enqueue(task.id, "Original request");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "review", title: "Review", outcome: "Review the work", input: "Keep the assignment", inputId: "review", model: fixtureModel });
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" } }));
    const saved = await app.tasks.get(task.id); assert.ok(saved.worker.state === "bound");
    const old: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id,
      binding, instructions: "Current rules", model: fixtureModel, cwd: host.cwd, interactive: true };
    const conversation = await app.tasks.conversation(task.conversation_id);
    let started = () => {}; const startedTurn = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = () => {}; const cancelSeen = new Promise<void>((resolve) => { cancelled = resolve; });
    const drain = new Promise<void>((resolve) => { release = resolve; });
    app.faux.setResponses([async (_context, options) => {
      const signal = options?.signal; assert.ok(signal); started();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      cancelled(); await drain; return fauxAssistantMessage("A late stale result");
    }, fauxAssistantMessage("Continued after the closed tab")]);
    let fenced = false;
    running = app.tasks.run(old, () => () => {}, () => {}, [], undefined, undefined, {
      signal: controller.signal, async ready() {}, answer() {}, idle() {}, async fence() { fenced = true; await conversation.abort(BACKGROUND_CONTEXT); },
    });
    await startedTurn; controller.abort();
    await app.tasks.enqueue(task.id, "Continue after closing the session", "after-close");
    const replacement = { ...binding, session_id: "session:66666666-6666-4666-8666-666666666666", block_id: "block:77777777-7777-4777-8777-777777777777" };
    let creates = 0;
    const recovering = app.tasks.dispatch(task.id, host, async (command) => {
      if (command.type === "on_node") { assert.equal(command.host_id, binding.host_id); assert.equal(command.command.type, "inspect_worker"); return { type: "worker_presence", presence: { state: "missing_session" } }; }
      assert.equal(command.type, "spawn_worker"); creates += 1; assert.equal(fenced, true); return { type: "spawned", binding: replacement };
    });
    await cancelSeen; assert.equal(creates, 0); assert.equal(app.tasks.isRunning(task.id), true);
    release(); const reopened = await recovering; await running; running = undefined;
    assert.equal(creates, 1); assert.equal(reopened.conversation_id, task.conversation_id); assert.equal(reopened.id, task.id);
    assert.deepEqual(reopened.model, fixtureModel); assert.equal(reopened.agents[0]?.conversation_id, child.conversation_id);
    assert.equal(reopened.agents[0]?.worker.state, "unassigned"); assert.equal(reopened.agents[0]?.pending[0]?.content, "Keep the assignment");
    assert.equal(reopened.pending[0]?.id, "after-close"); assert.equal(reopened.summary, ""); assert.ok(reopened.worker.state === "bound");
    assert.notEqual(reopened.worker.allocation_id, old.allocation_id);
    await assert.rejects(app.tasks.run(old, () => () => {}, () => {}), /binding is not confirmed/);
    const result = await app.tasks.run({ ...old, allocation_id: reopened.worker.allocation_id, binding: replacement, interactive: false }, () => () => {}, () => {});
    assert.equal(result.text, "Continued after the closed tab"); assert.equal(app.faux.state.callCount, 2);
    const visible = (await history(conversation, null)).flatMap((frame) => frame.messages);
    assert.equal(visible.some((message) => message.text === "A late stale result"), false);
    assert.equal((await app.tasks.get(task.id)).pending.length, 0);
    let childCreates = 0;
    const continued = await app.tasks.continueAgent(task.id, child.id, "Continue the retained review", "review-after-close", async (command) => {
      assert.equal(command.type, "spawn_subagent"); assert.equal(command.parent.session_id, replacement.session_id); childCreates += 1;
      return { type: "spawned", binding: { ...replacement, block_id: "block:88888888-8888-4888-8888-888888888888" } };
    });
    assert.equal(childCreates, 1); assert.equal(continued.agents[0]?.conversation_id, child.conversation_id);
    assert.deepEqual(continued.agents[0]?.pending.map((input) => input.content), ["Keep the assignment", "Continue the retained review"]);
  } finally { release(); controller.abort(); await running?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a failed Rex inspection remains uncertain and never substitutes an allocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-session-unknown-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Retain work", outcome: "Keep its ownership" });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    await app.tasks.enqueue(task.id, "Keep this request", "pending"); let creates = 0;
    const uncertain = await app.tasks.dispatch(task.id, host, async (command) => {
      if (command.type === "spawn_worker") creates += 1;
      return { type: "failed", message: "The owning host is unreachable" };
    });
    assert.equal(uncertain.worker.state, "uncertain"); assert.equal(creates, 0);
    assert.equal(uncertain.pending[0]?.id, "pending"); assert.equal(uncertain.conversation_id, task.conversation_id);
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => { creates += 1; return { type: "spawned", binding }; }), /needs reconciliation/);
    assert.equal(creates, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an interactive task serializes local and chief inputs, wakes while idle and reopens its actual history", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-interactive-")); let app = await open(directory);
  const controller = new AbortController(); let running: Promise<unknown> | undefined;
  let stop: (() => Promise<void>) | undefined; let releaseTurn = () => {}; let releaseAdmission = () => {};
  try {
    const task = await app.tasks.create({ title: "Interactive work", outcome: "Retain and finish follow-ups" });
    await app.tasks.enqueue(task.id, "Initial chief instruction");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await app.tasks.get(task.id); assert.ok(saved.worker.state === "bound");
    const command: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id,
      allocation_id: saved.worker.allocation_id, binding, instructions: "Current instructions", model: fixtureModel, cwd: host.cwd, interactive: true };
    const answers: string[] = []; const live: ModelActivity[] = []; const inputs: string[] = []; let idleCount = 0; let wake = () => {};
    const idle = async (count: number) => { while (idleCount < count) await new Promise<void>((resolve) => { wake = resolve; }); };
    app.faux.setResponses([fauxAssistantMessage([fauxThinking("Published reasoning summary."), { type: "text", text: "Initial answer" }]),
      fauxAssistantMessage("Chief follow-up answer")]);
    running = app.tasks.run(command, () => () => {}, () => {}, [], undefined, undefined, {
      signal: controller.signal,
      async ready(conversation) { assert.equal(conversation.id.toString(), task.conversation_id); stop = await activity(app.session, conversation, (event) => live.push(event),
        (message) => { if (message.role === "user") inputs.push(message.text); }); },
      answer(_id, text) { answers.push(text); }, idle() { idleCount += 1; wake(); },
    });
    assert.equal(await Promise.race([idle(1).then(() => "idle"), running.then(() => "exited")]), "idle", "The task tab must remain attached after its first answer");
    assert.equal(app.tasks.isRunning(task.id), false, "An idle UI is a lease, not unfinished work");
    await assert.rejects(app.tasks.run(command, () => () => {}, () => {}), /attached worker/);
    await app.tasks.enqueue(task.id, "Chief follow-up while the tab is idle");
    await app.tasks.dispatch(task.id, host, async () => { throw new Error("An attached worker must wake without another Rex session"); });
    await idle(2);
    let started = () => {};
    const startedTurn = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    app.faux.setResponses([async () => { started(); await gate; return fauxAssistantMessage("Local follow-up answer"); },
      fauxAssistantMessage("Queued chief answer")]);
    let admitStarted = () => {};
    const admitting = new Promise<void>((resolve) => { admitStarted = resolve; });
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; }); let failOne = true;
    app.tasks.guardResources({ async attach() {
      if (failOne) { failOne = false; admitStarted(); await admissionGate; throw new Error("Resource admission refused"); }
    } });
    const refused = app.tasks.enqueue(task.id, "This refused input must not hide another active turn", "refused");
    await admitting;
    assert.equal(app.tasks.isRunning(task.id), true, "The admission guard protects work while the resource check is still pending");
    await app.tasks.input(command, "Reply typed directly in the task tab", "local-input");
    await startedTurn;
    releaseAdmission(); await assert.rejects(refused, /Resource admission refused/);
    assert.equal(app.tasks.isRunning(task.id), true, "A refused concurrent admission cannot clear another turn's busy guard");
    await app.tasks.enqueue(task.id, "Chief input while the local turn runs", "chief-input");
    assert.equal(app.tasks.isRunning(task.id), true);
    releaseTurn(); await idle(3);
    assert.deepEqual(answers, ["Initial answer", "Chief follow-up answer", "Local follow-up answer", "Queued chief answer"]);
    controller.abort(); await running; running = undefined; await stop?.(); stop = undefined;
    assert.equal(live.flatMap((event) => event.type === "thinking" ? [event.text] : []).join(""), "Published reasoning summary.");
    assert.deepEqual(inputs, ["Initial chief instruction", "Chief follow-up while the tab is idle", "Reply typed directly in the task tab", "Chief input while the local turn runs"]);
    await assert.rejects(app.tasks.input(command, "Late detached input", "late"), /no longer attached/);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const reopened = await app.tasks.get(task.id); assert.equal(reopened.conversation_id, task.conversation_id);
    const frames = await history(await app.tasks.conversation(reopened.conversation_id), null);
    const visible = frames.flatMap((frame) => frame.messages);
    assert.deepEqual(visible.filter((message) => message.role === "user").map((message) => message.text),
      ["Initial chief instruction", "Chief follow-up while the tab is idle", "Reply typed directly in the task tab", "Chief input while the local turn runs"]);
    assert.deepEqual(visible.filter((message) => message.role === "assistant").map((message) => message.text), answers);
    assert.equal(app.faux.state.callCount, 0, "Rendering stored history must not run a model");
  } finally {
    releaseAdmission(); releaseTurn(); controller.abort(); await running?.catch(() => {}); await stop?.();
    await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
});

test("an idle interactive child delivers its result and accepts another assignment without blocking parent resolution", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-interactive-child-")); const app = await open(directory);
  const controller = new AbortController(); let running: Promise<unknown> | undefined;
  try {
    const task = await app.tasks.create({ title: "Parent", outcome: "Complete after review" });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "review", title: "Review", outcome: "Review the change",
      input: "Review the first change", inputId: "review-first", model: fixtureModel });
    const childBinding = { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" };
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: childBinding }));
    const saved = (await app.tasks.get(task.id)).agents[0]; assert.ok(saved?.worker.state === "bound");
    const command: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id, agent_id: child.id,
      allocation_id: saved.worker.allocation_id, binding: childBinding, instructions: "", model: fixtureModel, cwd: host.cwd, interactive: true };
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("report_result", { summary: "Review passed" }), { stopReason: "toolUse" }), fauxAssistantMessage("First review complete"),
      fauxAssistantMessage(fauxToolCall("report_result", { summary: "Review passed" }), { stopReason: "toolUse" }), fauxAssistantMessage("Second review complete"),
    ]);
    let idleCount = 0; let wake = () => {};
    const idle = async (count: number) => { while (idleCount < count) await new Promise<void>((resolve) => { wake = resolve; }); };
    running = app.tasks.run(command, (conversation) => app.executions.bind(conversation.id.toString(), {
      cwd: host.cwd, hosts: [host], call: async () => { throw new Error("No Rex effects expected"); },
    }), () => {}, [app.tools.worker], undefined, undefined, {
      signal: controller.signal, async ready() {}, answer() {}, idle() { idleCount += 1; wake(); },
    });
    await idle(1);
    assert.equal((await app.tasks.get(task.id)).pending.length, 1, "The parent gets the result before the tab closes");
    assert.equal((await app.tasks.waitAgents(task.id, 0))[0]?.state.state, "done");
    assert.equal(app.tasks.canResolve(await app.tasks.get(task.id)), true);
    await app.tasks.continueAgent(task.id, child.id, "Review the second change", "review-second");
    await idle(2);
    assert.equal((await app.tasks.get(task.id)).pending.length, 2);
    assert.equal(app.tasks.canResolve(await app.tasks.get(task.id)), true);
    controller.abort(); await running; running = undefined;
    assert.equal((await app.tasks.get(task.id)).pending.length, 2, "Detach does not publish the child result again");
    await assert.rejects(app.tasks.continueAgent(task.id, child.id, "Detached follow-up", "review-third"), /no longer attached/);
  } finally { controller.abort(); await running?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("detaching before a child's first turn preserves its pending assignment without publishing a fake result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-detached-child-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Parent", outcome: "Complete after review" });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "review", title: "Review", outcome: "Review the change",
      input: "Keep this assignment pending", inputId: "review-pending", model: fixtureModel });
    const childBinding = { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" };
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: childBinding }));
    const saved = (await app.tasks.get(task.id)).agents[0]; assert.ok(saved?.worker.state === "bound");
    const controller = new AbortController(); controller.abort();
    await app.tasks.run({ type: "run_task", task_id: task.id, agent_id: child.id,
      allocation_id: saved.worker.allocation_id, binding: childBinding, instructions: "", model: fixtureModel, cwd: host.cwd, interactive: true },
    () => () => {}, () => {}, [], undefined, undefined, { signal: controller.signal, async ready() {}, answer() {}, idle() {} });
    const retained = await app.tasks.get(task.id);
    assert.equal(retained.pending.length, 0); assert.equal(retained.agents[0]?.pending.length, 1);
    assert.equal(retained.agents[0]?.state.state, "open"); assert.equal(app.faux.state.callCount, 0);
    assert.equal(app.tasks.isRunning(task.id), false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("task agents own conversations and named terminals in one Rex session, then wake their parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-child-")); let app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Inspect change", outcome: "Verify and finish the change" });
    await app.tasks.enqueue(task.id, "Delegate the review and finish after its result.");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    let parent = await app.tasks.get(task.id);
    if (parent.worker.state !== "bound") throw new Error("Missing parent binding");
    const childBinding = { ...binding, window_id: "window:55555555-5555-4555-8555-555555555555",
      block_id: "block:66666666-6666-4666-8666-666666666666" };
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("spawn_agent", { title: "Review", outcome: "Review the bounded change", input: "Inspect the current change." }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("record_task", { summary: "Too soon", state: { state: "resolved", evidence: "No review result yet" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Review is running."),
    ]);
    let nativeCreates = 0;
    await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: parent.worker.allocation_id,
      binding, instructions: "", model: fixtureModel, cwd: host.cwd }, (conversation) => app.executions.bind(conversation.id.toString(), {
        cwd: host.cwd, hosts: [host], call: async (command) => {
          assert.equal(command.type, "spawn_subagent");
          if (command.type !== "spawn_subagent") throw new Error("Expected child allocation");
          nativeCreates += 1;
          const saved = await app.tasks.get(task.id); const agent = saved.agents[0]; assert.ok(agent);
          assert.equal(agent.worker.state, "allocating"); assert.equal(agent.pending.length, 1);
          assert.equal(command.parent.session_id, binding.session_id); assert.equal(command.title, "Review");
          assert.notEqual(agent.conversation_id, task.conversation_id);
          return { type: "spawned", binding: childBinding };
        },
      }), () => {}, [app.tools.host, app.tools.worker]);
    assert.equal(nativeCreates, 1); parent = await app.tasks.get(task.id); assert.equal(parent.state.state, "open");
    const child = parent.agents[0]; assert.ok(child); assert.equal(child.worker.state, "bound");
    if (child.worker.state !== "bound") throw new Error("Missing child binding");
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { task_id: task.id, summary: "Unauthorized parent change", state: { state: "resolved", evidence: "Child cannot resolve parent" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("report_result", { summary: "Reviewed the change; concrete checks passed." }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Review complete."),
    ]);
    const replacement = { ...binding, block_id: "block:77777777-7777-4777-8777-777777777777" };
    let resumed = 0;
    await app.tasks.run({ type: "run_task", task_id: task.id, agent_id: child.id, allocation_id: child.worker.allocation_id,
      binding: childBinding, instructions: "", model: fixtureModel, cwd: host.cwd }, (conversation) => app.executions.bind(conversation.id.toString(), {
        cwd: host.cwd, hosts: [host], call: async () => { throw new Error("No direct child host effects expected"); },
      }), () => { throw new Error("Child results belong to the parent"); }, [app.tools.host, app.tools.worker], async (command) => {
        assert.equal(command.type, "resume_worker"); resumed += 1;
        assert.equal((await app.tasks.get(task.id)).pending.length, 1);
        return { type: "spawned", binding: replacement };
      });
    assert.equal(resumed, 1); parent = await app.tasks.get(task.id);
    assert.equal(parent.state.state, "open"); assert.equal(parent.agents[0]?.state.state, "done");
    assert.equal(parent.agents[0]?.summary, "Reviewed the change; concrete checks passed.");
    const childConversation = await app.tasks.conversation(child.conversation_id);
    await childConversation.submit({ type: "write", entry: { kind: "fixture.child_evidence", model: [
      { role: "user", content: "The zirconium connector detail exists only in the reviewer conversation.", timestamp: Date.now() },
    ] } }, BACKGROUND_CONTEXT);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    parent = await app.tasks.get(task.id); assert.equal(parent.agents.length, 1); assert.equal(parent.pending.length, 1);
    assert.equal((await app.tasks.search("zirconium connector"))[0]?.id, task.id);
    assert.match(await app.tasks.history(task.id, 120_000, child.id), /zirconium connector/);
    if (parent.worker.state !== "bound") throw new Error("Missing resumed binding");
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_agents", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("record_task", { summary: "Finished after review", state: { state: "resolved", evidence: "Review and checks passed" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished after review."),
    ]);
    await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: parent.worker.allocation_id,
      binding: replacement, instructions: "", model: fixtureModel, cwd: host.cwd }, (conversation) => app.executions.bind(conversation.id.toString(), {
        cwd: host.cwd, hosts: [host], call: async () => { throw new Error("Parent result should reuse the conversation"); },
      }), () => {}, [app.tools.host, app.tools.worker]);
    assert.equal((await app.tasks.get(task.id)).state.state, "resolved");
    assert.match(await app.tasks.history(task.id), /concrete checks passed/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database);
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  const session = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models));
  const executions = new Executions();
  const tools = createAppTools(tasks, executions);
  registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker);
  return { session, tasks, executions, tools, faux };
}

test("task creation is idempotent and source links/full history survive SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-"));
  let app = await open(directory);
  try {
    const id = randomUUID();
    const source = { provider: "mail", account: "alpha", thread_id: "thread-one" };
    const created = await app.tasks.create({ id, title: "Supplier quote", outcome: "Resolve the quote", sources: [source] });
    const duplicate = await app.tasks.create({ id, title: "Ignored duplicate", outcome: "Not another conversation" });
    assert.equal(duplicate.conversation_id, created.conversation_id);
    assert.equal((await app.tasks.list()).length, 1);
    const conversation = await app.tasks.conversation(created.conversation_id);
    await conversation.submit({ type: "write", entry: { kind: "fixture.evidence", model: [
      { role: "user", content: "The original message names the violet capacitor.", timestamp: Date.now() },
    ] } }, BACKGROUND_CONTEXT);
    await conversation.submit({ type: "write", entry: { kind: "fixture.later_context", model: [
      { role: "user", content: "Later unrelated context. ".repeat(6000), timestamp: Date.now() },
    ] } }, BACKGROUND_CONTEXT);
    await app.session.close(BACKGROUND_CONTEXT);
    app = await open(directory);
    assert.equal((await app.tasks.search("violet capacitor"))[0]?.id, id);
    assert.equal((await app.tasks.search("", [source]))[0]?.id, id);
    assert.equal((await app.tasks.search("", [{ ...source, account: "beta" }])).length, 0);
    assert.doesNotMatch(await app.tasks.history(id), /violet capacitor/, "Read context is bounded while lookup still searches original history");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("several relevant conversations remain distinct and searchable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  try {
    const source = { provider: "mail", account: "alpha", thread_id: "offer" };
    const listing = await app.tasks.create({ title: "Marketplace listing", outcome: "Price the jacket", sources: [source] });
    const offer = await app.tasks.create({ title: "Marketplace offer", outcome: "Resolve the jacket offer", sources: [source] });
    assert.notEqual(listing.conversation_id, offer.conversation_id);
    assert.deepEqual(new Set((await app.tasks.search("jacket", [source])).map((task) => task.id)), new Set([listing.id, offer.id]));
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("task input bytes are bounded and stable input IDs cannot change content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Bounded work", outcome: "Drain a bounded instruction queue" });
    const id = randomUUID();
    await app.tasks.enqueue(task.id, "First instruction", id); await app.tasks.enqueue(task.id, "First instruction", id);
    await assert.rejects(app.tasks.enqueue(task.id, "Changed instruction", id), /different content/);
    await assert.rejects(app.tasks.enqueue(task.id, "🧪".repeat(20_000)), /UTF-8 bytes/);
    assert.equal((await app.tasks.get(task.id)).pending.length, 1);
    assert.equal((await app.tasks.get(task.id)).pending[0]?.content, "First instruction");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("input arriving during recovered history finalization is drained by the attached worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  let releaseHistory: () => void = () => {};
  try {
    const task = await app.tasks.create({ title: "Recover work", outcome: "Finish every admitted instruction" });
    await app.tasks.enqueue(task.id, "Initial instruction");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await app.tasks.get(task.id);
    if (saved.worker.state !== "bound") throw new Error("Missing binding");
    const command = { type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id,
      binding, instructions: "", model: fixtureModel, cwd: host.cwd };
    app.faux.setResponses([fauxAssistantMessage("Initial result")]);
    await app.tasks.run({ ...command, type: "run_task" }, () => () => {}, () => {});
    let historyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { historyStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    const nativeConversation = app.tasks.conversation.bind(app.tasks);
    let pause = true;
    app.tasks.conversation = async (id) => {
      const conversation = await nativeConversation(id);
      if (id === task.conversation_id && pause) {
        const entries = conversation.entries.bind(conversation);
        conversation.entries = async (filter, limit, cursor, context) => {
          const page = await entries(filter, limit, cursor, context);
          if (pause) { pause = false; historyStarted(); await gate; }
          return page;
        };
      }
      return conversation;
    };
    app.faux.setResponses([fauxAssistantMessage("Follow-up drained without another dispatch.")]);
    const running = app.tasks.run({ ...command, type: "run_task" }, () => () => {}, () => {});
    await started;
    await app.tasks.enqueue(task.id, "Follow-up during finalization");
    await app.tasks.dispatch(task.id, host, async () => { throw new Error("The attached actor must drain this input"); });
    releaseHistory(); await running;
    assert.equal((await app.tasks.get(task.id)).pending.length, 0);
    assert.match(await app.tasks.history(task.id), /Follow-up drained/);
    assert.equal(app.faux.state.callCount, 2);
  } finally { releaseHistory(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("delegation persists the chosen repository cwd and bound tasks reuse it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    const cwd = "/workspace/board"; let nativeCalls = 0;
    const release = app.executions.bind(root.id.toString(), { model: fixtureModel, cwd: host.cwd, hosts: [host], call: async (command) => {
      assert.ok(command.type === "spawn_worker" || command.type === "resume_worker");
      if (command.type !== "spawn_worker" && command.type !== "resume_worker") throw new Error("Expected a task worker");
      assert.equal(command.host.cwd, cwd); nativeCalls += 1;
      return { type: "spawned", binding };
    } });
    try {
      await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.main] }, BACKGROUND_CONTEXT);
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("delegate_task", { input: "Inspect the repository", title: "Board change", outcome: "Verify the change", cwd }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Started the repository task."),
      ]);
      await (await root.submit({ type: "input", content: "Work in the board repository" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      const task = (await app.tasks.list())[0]; assert.ok(task);
      assert.equal(task.worker.state, "bound");
      if (task.worker.state !== "bound") throw new Error("Missing repository worker");
      assert.equal(task.worker.host.cwd, cwd); assert.equal(task.pending.length, 1);
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("delegate_task", { task_id: task.id, input: "Wrong repository", cwd: "/workspace/other" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("This task belongs to its existing repository."),
      ]);
      await (await root.submit({ type: "input", content: "Try changing its repository" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      assert.equal(nativeCalls, 1); assert.equal((await app.tasks.get(task.id)).pending.length, 1);
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("delegate_task", { task_id: task.id, input: "Continue its original repository" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Continued its existing repository."),
      ]);
      await (await root.submit({ type: "input", content: "Continue the task" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      assert.equal(nativeCalls, 2);
      const continued = await app.tasks.get(task.id);
      if (continued.worker.state !== "bound") throw new Error("Missing continued worker");
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("exec", { program: "inspect", args: [] }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Inspected the chosen repository."), fauxAssistantMessage("Continued the chosen repository."),
      ]);
      await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: continued.worker.allocation_id,
        binding, instructions: "Repository guidance", model: fixtureModel, cwd }, (conversation, workerHost) => {
        assert.equal(workerHost.cwd, cwd);
        return app.executions.bind(conversation.id.toString(), { cwd: workerHost.cwd, hosts: [workerHost], call: async (command) => {
          assert.equal(command.type, "exec"); if (command.type !== "exec") throw new Error("Expected repository operation");
          assert.equal(command.cwd, cwd); return { type: "process", exit_code: 0, stdout: "Verified", stderr: "", truncated: false };
        } });
      }, () => {}, [app.tools.host, app.tools.worker]);
      assert.equal((await app.tasks.get(task.id)).pending.length, 0);
    } finally { release(); }
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("allocation is committed before the native create and concurrent dispatch cannot duplicate it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Inspect board", outcome: "Verify source state" });
    await app.tasks.enqueue(task.id, "Check the current source.");
    let calls = 0;
    const call = async (command: HostCommand): Promise<HostResult> => {
      calls += 1;
      assert.equal(command.type, "spawn_worker");
      const saved = await app.tasks.get(task.id);
      assert.equal(saved.worker.state, "allocating"); assert.equal(saved.pending.length, 1);
      return { type: "spawned", binding };
    };
    const results = await Promise.allSettled([app.tasks.dispatch(task.id, host, call), app.tasks.dispatch(task.id, host, call)]);
    assert.equal(calls, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await app.tasks.get(task.id)).worker.state, "bound");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an interrupted create stays uncertain after reopen and cannot create a second session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); let app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Check source", outcome: "Verify source" });
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => { throw new Error("lost receipt"); }), /could not be confirmed/);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    let calls = 0;
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => { calls += 1; return { type: "spawned", binding }; }), /reconciliation/);
    assert.equal(calls, 0); assert.equal((await app.tasks.get(task.id)).worker.state, "uncertain");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("exact allocation revocation preserves pending work and rejects stale worker admission after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-recovery-")); let app = await open(directory);
  try {
    const source = { provider: "mail", account: "fixture", thread_id: "thread-one" };
    const task = await app.tasks.create({ title: "Recover startup", outcome: "Finish the retained assignment", model: fixtureModel, sources: [source] });
    await app.tasks.enqueue(task.id, "Keep this input exactly once.", "original-input");
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => { throw new Error("Lost startup reply"); }), /could not be confirmed/);
    const uncertain = await app.tasks.get(task.id); if (uncertain.worker.state !== "uncertain") throw new Error("Expected uncertainty");
    await assert.rejects(app.tasks.revokeAllocation(task.id, "different-allocation"), /exact unresolved allocation/);
    await app.tasks.revokeAllocation(task.id, uncertain.worker.allocation_id);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const retained = await app.tasks.get(task.id);
    assert.deepEqual(retained.worker, { state: "unassigned" }); assert.equal(retained.conversation_id, task.conversation_id);
    assert.deepEqual(retained.pending, uncertain.pending); assert.deepEqual(retained.model, fixtureModel); assert.deepEqual(retained.sources, [source]);
    await assert.rejects(app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: uncertain.worker.allocation_id,
      binding, instructions: "", cwd: host.cwd, model: fixtureModel }, () => { throw new Error("A stale worker must never attach"); }, () => {}), /binding is not confirmed/);
    assert.equal(app.faux.state.callCount, 0); assert.deepEqual((await app.tasks.get(task.id)).pending, uncertain.pending);
    await assert.rejects(app.tasks.revokeAllocation(task.id, uncertain.worker.allocation_id), /exact unresolved allocation/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

for (const transition of ["spawn", "spawn-error", "resume", "resume-error"]) {
  test(`a late ${transition} result cannot resurrect a revoked allocation or overwrite its replacement`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-recovery-")); const app = await open(directory);
    let release: () => void = () => {};
    try {
      const task = await app.tasks.create({ title: "Fence startup", outcome: "Keep exactly one admitted worker", model: fixtureModel });
      await app.tasks.enqueue(task.id, "Keep the same original input.");
      if (transition.startsWith("resume")) await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const original = app.tasks.dispatch(task.id, host, async () => {
        entered(); await gate;
        if (transition.endsWith("error")) throw new Error("Late transport failure");
        return { type: "spawned", binding };
      });
      void original.catch(() => {}); await started;
      const allocating = await app.tasks.get(task.id); if (allocating.worker.state !== "allocating") throw new Error("Expected allocation");
      await app.tasks.revokeAllocation(task.id, allocating.worker.allocation_id);
      const replacementBinding = { ...binding, session_id: "session:88888888-8888-4888-8888-888888888888" };
      const replacement = await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding: replacementBinding }));
      assert.equal(replacement.worker.state, "bound");
      release(); await assert.rejects(original, /late creation result was ignored/);
      const current = await app.tasks.get(task.id);
      assert.deepEqual(current.worker, replacement.worker); assert.equal(current.pending.length, 1);
      await assert.rejects(app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: allocating.worker.allocation_id,
        binding, instructions: "", cwd: host.cwd, model: fixtureModel }, () => { throw new Error("No old attachment"); }, () => {}), /binding is not confirmed/);
      assert.equal(app.faux.state.callCount, 0);
    } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
  });
}

test("revoking a child allocation fences late terminal creation without changing its parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-recovery-")); const app = await open(directory);
  let release: () => void = () => {};
  try {
    const task = await app.tasks.create({ title: "Parent", outcome: "Finish after review", model: fixtureModel });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const child = await app.tasks.createAgent(task.id, { id: "review", title: "Review", outcome: "Review the change", input: "Inspect the evidence.", inputId: "review-input" });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = app.tasks.dispatchAgent(task.id, child.id, async () => { entered(); await gate; return { type: "spawned", binding }; });
    void original.catch(() => {}); await started;
    const allocated = (await app.tasks.get(task.id)).agents[0]; assert.ok(allocated);
    if (allocated.worker.state !== "allocating") throw new Error("Expected child allocation");
    await app.tasks.revokeAllocation(task.id, allocated.worker.allocation_id, child.id);
    const replacement = await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned",
      binding: { ...binding, block_id: "block:88888888-8888-4888-8888-888888888888" } }));
    release(); await assert.rejects(original, /late creation result was ignored/);
    const current = await app.tasks.get(task.id);
    assert.deepEqual(current.worker, replacement.worker); assert.deepEqual(current.agents[0]?.worker, replacement.agents[0]?.worker);
    assert.deepEqual(current.agents[0]?.pending, child.pending); assert.deepEqual(current.agents[0]?.model, fixtureModel);
  } finally { release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("allocation recovery rejects an attached run before changing its worker or input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-recovery-")); const app = await open(directory);
  let release: () => void = () => {}; let running: Promise<unknown> | undefined;
  try {
    const task = await app.tasks.create({ title: "Running task", outcome: "Finish the attached turn", model: fixtureModel });
    const saved = await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    if (saved.worker.state !== "bound") throw new Error("Expected worker");
    await app.tasks.enqueue(task.id, "Finish the active assignment.");
    let attached: () => void = () => {};
    const started = new Promise<void>((resolve) => { attached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    app.faux.setResponses([fauxAssistantMessage("The attached assignment completed.")]);
    running = app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id,
      binding, instructions: "", cwd: host.cwd, model: fixtureModel }, () => () => {}, () => {}, [], undefined,
      async () => { attached(); await gate; });
    await started;
    await assert.rejects(app.tasks.revokeAllocation(task.id, saved.worker.allocation_id), /attached worker must finish/);
    assert.deepEqual((await app.tasks.get(task.id)).worker, saved.worker); assert.equal((await app.tasks.get(task.id)).pending.length, 1);
    release(); await running;
  } finally { release(); await running; await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("resuming a task keeps its session and conversation while replacing an exited worker binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Continue inspection", outcome: "Finish source inspection" });
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    await app.tasks.enqueue(task.id, "Continue the same inspection.");
    const replacement = { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" };
    const resumed = await app.tasks.dispatch(task.id, host, async (command) => {
      assert.equal(command.type, "resume_worker");
      assert.equal((await app.tasks.get(task.id)).worker.state, "allocating");
      return { type: "spawned", binding: replacement };
    });
    assert.equal(resumed.conversation_id, task.conversation_id);
    assert.equal(resumed.worker.state, "bound");
    if (resumed.worker.state !== "bound") throw new Error("Missing resumed binding");
    assert.equal(resumed.worker.binding.session_id, binding.session_id);
    app.faux.setResponses([fauxAssistantMessage("Continued the existing inspection.")]);
    await assert.rejects(app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: resumed.worker.allocation_id,
      binding, instructions: "", model: fixtureModel, cwd: host.cwd }, () => () => {}, () => {}), /binding is not confirmed/);
    assert.equal(app.faux.state.callCount, 0);
    assert.match((await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: resumed.worker.allocation_id,
      binding: replacement, instructions: "", model: fixtureModel, cwd: host.cwd }, () => () => {}, () => {})).text, /Continued/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an unconfirmed terminal startup keeps its session binding and queued correction through reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); let app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Unsubscribe mailing lists", outcome: "Finish the existing unsubscribe work" });
    const saved = await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    await app.tasks.enqueue(task.id, "Continue the same work.", "one-correction");
    const pending = await app.tasks.dispatch(task.id, host, async (command) => {
      assert.equal(command.type, "resume_worker", "Startup must not allocate another session");
      return { type: "worker_presence", presence: { state: "pending" } };
    });
    assert.deepEqual(pending.worker, saved.worker);
    assert.equal(pending.conversation_id, task.conversation_id);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const retained = await app.tasks.get(task.id);
    assert.deepEqual(retained.worker, saved.worker);
    assert.equal(retained.pending.length, 1);
    assert.equal(retained.pending[0]?.id, "one-correction");
    const resumed = await app.tasks.dispatch(task.id, host, async (command) => {
      assert.equal(command.type, "resume_worker"); return { type: "written" };
    });
    assert.deepEqual(resumed.worker, saved.worker);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("host replies are correlated to their request and release resources when a request ends", async () => {
  const emitted: { request: number; call: string; command: HostCommand }[] = [];
  const requests = new HostRequests((request, call, command) => emitted.push({ request, call, command }));
  const pending = requests.call(7, { type: "read_file", path: "example", offset: 0, limit: 10 });
  const call = emitted[0]; assert.ok(call);
  assert.equal(requests.reply(8, call.call, { type: "file", content: "wrong", truncated: false }), false);
  assert.equal(requests.reply(7, call.call, { type: "file", content: "right", truncated: false }), true);
  assert.deepEqual(await pending, { type: "file", content: "right", truncated: false });
  assert.equal(requests.reply(7, call.call, { type: "written" }), false);
  const abandoned = requests.call(9, { type: "read_file", path: "example", offset: 0, limit: 10 });
  const rejected = assert.rejects(abandoned, /ended before/); requests.finish(9); await rejected;
});

test("worker host tools execute through the attached client while the main conversation stays available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  let releaseHost: (result: HostResult) => void = () => {};
  try {
    const task = await app.tasks.create({ title: "Inspect source", outcome: "Verify the example" });
    await app.tasks.enqueue(task.id, "Inspect the example source.");
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const saved = await app.tasks.get(task.id); assert.equal(saved.worker.state, "bound");
    if (saved.worker.state !== "bound") throw new Error("Missing fixture binding");
    let started: () => void = () => {};
    const hostStarted = new Promise<void>((resolve) => { started = resolve; });
    const hostResult = new Promise<HostResult>((resolve) => { releaseHost = resolve; });
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("exec", { program: "inspect", args: ["literal value"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Main stays available."), fauxAssistantMessage("Worker verified the source."),
      fauxAssistantMessage("The follow-up was verified too."),
    ]);
    const notices: string[] = [];
    const running = app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id,
      binding, instructions: "Use verified source.", model: fixtureModel, cwd: host.cwd },
    (conversation) => app.executions.bind(conversation.id.toString(), { cwd: host.cwd, hosts: [], call: async (command) => {
      assert.deepEqual(command, { type: "exec", program: "inspect", args: ["literal value"], cwd: host.cwd, timeout_seconds: 900 });
      started(); return hostResult;
    } }), (_task, answer) => notices.push(answer), [app.tools.host, app.tools.worker]);
    await hostStarted;
    await app.tasks.enqueue(task.id, "Also inspect the follow-up.");
    await app.tasks.dispatch(task.id, host, async () => { throw new Error("An active worker must be reused"); });
    await assert.rejects(app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id,
      binding, instructions: "", model: fixtureModel, cwd: host.cwd }, () => () => {}, () => {}), /already has/);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    const main = await root.submit({ type: "input", content: "Are you available?" }, BACKGROUND_CONTEXT);
    assert.equal((await main.wait(BACKGROUND_CONTEXT)).status, "done");
    releaseHost({ type: "process", exit_code: 0, stdout: "verified", stderr: "", truncated: false });
    assert.match((await running).text, /follow-up was verified/);
    assert.equal(notices.length, 2);
    assert.equal((await app.tasks.get(task.id)).pending.length, 0);
    assert.equal((await app.tasks.get(task.id)).state.state, "open", "A worker answer alone does not resolve the user's outcome");
    const rootContext = await root.context(BACKGROUND_CONTEXT);
    assert.ok(rootContext.messages.some((message) => message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text.includes("follow-up was verified"))),
    "The main model sees the actual worker notice when the user responds");
  } finally {
    releaseHost({ type: "failed", message: "test cleanup" });
    await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
});

test("a killed coordinator recovers an admitted Pi submission even after app pending was cleared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-"));
  const id = randomUUID();
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/task-admission-child.js", import.meta.url)), directory, id],
    { stdio: ["ignore", "pipe", "pipe"] });
  let app: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const lines = createInterface({ input: child.stdout });
    const first = await lines[Symbol.asyncIterator]().next();
    assert.equal(first.value, "ADMITTED");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    lines.close();
    app = await open(directory);
    const task = await app.tasks.get(id);
    assert.equal(task.pending.length, 0); assert.equal(task.worker.state, "bound");
    if (task.worker.state !== "bound") throw new Error("Missing persisted binding");
    app.faux.setResponses([fauxAssistantMessage("Recovered the original requested work.")]);
    const recovered = await app.tasks.run({ type: "run_task", task_id: id, allocation_id: task.worker.allocation_id,
      binding: task.worker.binding, instructions: "Use verified source.", model: fixtureModel, cwd: host.cwd },
    () => () => {}, () => {});
    assert.match(recovered.text, /Recovered the original/);
    const conversation = await app.tasks.conversation(task.conversation_id);
    const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(page.items.filter((entry) => UserEntry.is(entry)).length, 1);
  } finally {
    child.kill("SIGKILL");
    if (app !== undefined) await app.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker tools reject unrelated task writes and oversized reads while main may update another task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-task-")); const app = await open(directory);
  let releaseMain: (() => void) | undefined;
  try {
    const own = await app.tasks.create({ title: "Own inspection", outcome: "Inspect the own source" });
    const other = await app.tasks.create({ title: "Other inspection", outcome: "Keep this task independent" });
    await app.tasks.enqueue(own.id, "Inspect your own source.");
    await app.tasks.dispatch(own.id, host, async () => ({ type: "spawned", binding }));
    const task = await app.tasks.get(own.id);
    if (task.worker.state !== "bound") throw new Error("Missing worker binding");
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { task_id: other.id, summary: "Wrong owner",
        state: { state: "resolved", evidence: "This worker cannot establish it" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_file", { path: "example", limit: 262_145 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Both invalid tool calls were rejected."),
    ]);
    let calls = 0;
    await app.tasks.run({ type: "run_task", task_id: own.id, allocation_id: task.worker.allocation_id,
      binding, instructions: "Work on the own source.", model: fixtureModel, cwd: host.cwd },
    (conversation) => app.executions.bind(conversation.id.toString(), { cwd: host.cwd, hosts: [], call: async () => {
      calls += 1; return { type: "written" };
    } }), () => {}, [app.tools.host, app.tools.worker]);
    assert.equal(calls, 0);
    assert.equal((await app.tasks.get(other.id)).state.state, "open");
    assert.equal((await app.tasks.get(other.id)).summary, "");
    const conversation = await app.tasks.conversation(own.conversation_id);
    const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => ToolResultEntry.is(entry))
      .flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult" && message.isError).length, 2);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_task", { task_id: other.id, summary: "Verified by main",
        state: { state: "resolved", evidence: "Synthetic readback confirms completion" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Recorded verified completion."),
    ]);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    releaseMain = app.executions.bind(root.id.toString(), { model: fixtureModel, cwd: host.cwd, hosts: [], call: async () => ({ type: "written" }) });
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools.main] }, BACKGROUND_CONTEXT);
    const submission = await root.submit({ type: "input", content: "Record the verified completion." }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal((await app.tasks.get(other.id)).state.state, "resolved");
    assert.equal((await app.tasks.get(other.id)).summary, "Verified by main");
  } finally {
    releaseMain?.(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
});
