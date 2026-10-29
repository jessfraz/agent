import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions } from "../src/tools.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { ModelSelection } from "../src/generated/ModelSelection.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { fixtureModel } from "./model.js";

const host: WorkerHost = { host_id: null, name: "fixture", rex_server: null, coordinator: null,
  cwd: "/example/devices", agent_program: "/example/agent" };
const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
const senderModel: ModelSelection = { ...fixtureModel, provider: "anthropic" };

for (const sender of ["chief", "parent"]) {
  test(`${sender} steers an active worker through its public tool and can queue a separate turn`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tool-steering-")), registry = createRegistry(), models = createModels();
    const receiverProvider = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
    const senderProvider = fauxProvider({ provider: "anthropic", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
    models.setProvider(receiverProvider.provider); models.setProvider(senderProvider.provider);
    const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
      { models, registry, identity: { attribution: null }, settings: { steeringMode: "all", followUpMode: "one-at-a-time" } }, BACKGROUND_CONTEXT);
    const tasks = new TaskStore(session, new ConversationModels(models)), executions = new Executions(), tools = createAppTools(tasks, executions);
    registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker);
    const controller = new AbortController(); let running: Promise<unknown> | undefined; let release = () => {}, unbind = () => {};
    try {
      const task = await tasks.create({ title: "Device cleanup", outcome: "Finish the cleanup", model: sender === "chief" ? fixtureModel : senderModel });
      await tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
      const child = sender === "parent" ? await tasks.createAgent(task.id, { id: "review", inputId: "original", input: "Review existing configuration",
        title: "Review configuration", outcome: "Review the device configuration", model: fixtureModel }) : undefined;
      const receiverBinding = child === undefined ? binding : { ...binding, window_id: "window:55555555-5555-4555-8555-555555555555",
        block_id: "block:66666666-6666-4666-8666-666666666666" };
      if (child === undefined) await tasks.enqueue(task.id, "Review existing configuration", "original");
      else await tasks.dispatchAgent(task.id, child.id, async (command) => {
        assert.equal(command.type, "spawn_subagent"); assert.equal(command.parent.session_id, binding.session_id);
        return { type: "spawned", binding: receiverBinding };
      });
      const owner = await tasks.get(task.id), receiver = child === undefined ? owner : owner.agents.find((agent) => agent.id === child.id);
      assert.ok(receiver?.worker.state === "bound");
      const command: Extract<RuntimeCommand, { type: "run_task" }> = { type: "run_task", task_id: task.id,
        ...(child === undefined ? {} : { agent_id: child.id }), allocation_id: receiver.worker.allocation_id, binding: receiverBinding,
        cwd: host.cwd, instructions: "", model: fixtureModel, interactive: true };
      let entered = () => {}, idle = () => {};
      const held = new Promise<HostResult>((resolve) => { release = () => resolve({ type: "process", exit_code: 0, stdout: "complete", stderr: "", truncated: false }); });
      const started = new Promise<void>((resolve) => { entered = resolve; }), finished = new Promise<void>((resolve) => { idle = resolve; });
      const answers: string[] = [];
      receiverProvider.setResponses([fauxAssistantMessage(fauxToolCall("exec", { program: "held", args: [] }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Corrected current work"), fauxAssistantMessage("Independent later result")]);
      running = tasks.run(command, (conversation) => executions.bind(conversation.id.toString(), { cwd: host.cwd, hosts: [host],
        call: async () => { entered(); return held; } }), [tools.host], undefined, undefined,
        { signal: controller.signal, async ready() {}, answer(_id, text) { answers.push(text); }, idle() { idle(); } });
      await started;
      const conversation = await tasks.conversation(receiver.conversation_id);
      const toolName = sender === "chief" ? "delegate_task" : "continue_agent";
      const target = child === undefined ? { task_id: task.id } : { agent_id: child.id };
      senderProvider.setResponses([
        fauxAssistantMessage(fauxToolCall(toolName, { ...target, input: "Correct the active direction" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall(toolName, { ...target, input: "An independent later request", mode: "follow_up" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall(toolName, { ...target, input: "Another relevant correction", mode: "steer" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("The active worker has the corrections and the later request is queued.")]);
      const effects: HostCommand[] = [];
      const senderExecution = { cwd: "/example/coordinator", hosts: [host], model: senderModel,
        async call(command: HostCommand): Promise<HostResult> { effects.push(command); return { type: "written" }; } };
      if (sender === "chief") {
        const root = await session.root(BACKGROUND_CONTEXT); unbind = executions.bind(root.id.toString(), senderExecution);
        await tasks.inference.configure(root, senderModel, { extensions: [tools.main] });
        assert.equal((await (await root.submit({ type: "input", content: "Pass the corrections on promptly" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
      } else {
        assert.ok(owner.worker.state === "bound"); await tasks.enqueue(task.id, "Pass the corrections on promptly", "parent-instruction");
        await tasks.run({ type: "run_task", task_id: task.id, allocation_id: owner.worker.allocation_id, binding,
          cwd: host.cwd, instructions: "", model: senderModel, interactive: false },
          (conversation) => executions.bind(conversation.id.toString(), senderExecution), [tools.worker]);
      }
      const current = await tasks.get(task.id), pending = (child === undefined ? current : current.agents.find((agent) => agent.id === child.id))?.pending;
      assert.ok(pending);
      const correction = pending.find((input) => input.content === "Correct the active direction");
      const followUp = pending.find((input) => input.content === "An independent later request");
      const refinement = pending.find((input) => input.content === "Another relevant correction");
      assert.ok(correction && followUp && refinement);
      const submission = (id: string) => session.commit((tx) => tx.submissionByRequest(conversation.id, id), BACKGROUND_CONTEXT);
      assert.ok(await submission(correction.id), "A tool-driven correction must reach Pi while the receiver's current tool is still held");
      assert.ok(await submission(followUp.id)); assert.ok(await submission(refinement.id));
      assert.equal(correction.mode, "steer"); assert.equal(followUp.mode, "follow_up"); assert.equal(refinement.mode, "steer");
      assert.deepEqual(effects, [], "Sending to an attached actor must not allocate or resume another Rex terminal");
      release(); await finished;
      assert.deepEqual(answers, ["Corrected current work", "Independent later result"]);
      const original = await submission("original"), corrected = await submission(correction.id), refined = await submission(refinement.id), queued = await submission(followUp.id);
      assert.ok(original && corrected && refined && queued);
      assert.equal(corrected.answer, original.answer); assert.equal(refined.answer, original.answer); assert.notEqual(queued.answer, original.answer);
      assert.equal(receiverProvider.state.callCount, 3, "Corrections share the current native turn; only the explicit queue gets a later one");
      const retained = await tasks.get(task.id), retainedReceiver = child === undefined ? retained : retained.agents.find((agent) => agent.id === child.id);
      assert.ok(retainedReceiver?.worker.state === "bound"); assert.deepEqual(retainedReceiver.worker.binding, receiverBinding);
      assert.equal(retainedReceiver.conversation_id, receiver.conversation_id); assert.deepEqual(retainedReceiver.pending, []);
      assert.equal((await tasks.list()).length, 1);
    } finally {
      release(); controller.abort(); await running?.catch(() => {}); unbind(); await session.close(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
