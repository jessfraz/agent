import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { UserEntry } from "@earendil-works/pi-durable";
import { runScheduled } from "../src/scheduled.js";
import { pump } from "./fixtures/background-runtime.js";
import { openScheduled, scheduledOccurrence } from "./fixtures/scheduled-runtime.js";

test("scheduled work uses the existing task actor, current guidance and exact native input", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-scheduled-"));
  const app = await openScheduled(directory), controller = new AbortController();
  let worker: Promise<unknown> | undefined, scheduled: Promise<void> | undefined;
  try {
    app.faux.setResponses([async (context) => {
      assert.match(getCurrentSystemPrompt(context.messages), /FRESH_GLOBAL_POLICY/);
      assert.match(getCurrentSystemPrompt(context.messages), /FRESH_PROJECT_POLICY/);
      return fauxAssistantMessage(fauxToolCall("exec", { program: "example", args: [], cwd: scheduledOccurrence.job.cwd, timeout_seconds: 1 }), { stopReason: "toolUse" });
    }, fauxAssistantMessage("The scheduled review is complete.")]);
    scheduled = runScheduled(scheduledOccurrence, controller.signal, app);
    await pump(async () => (await app.tasks.list())[0]?.worker.state === "bound");
    const task = (await app.tasks.list())[0]; assert.ok(task);
    worker = app.worker(task.id, controller);
    await Promise.all([scheduled, worker]);
    const current = await app.tasks.get(task.id), conversation = await app.tasks.conversation(task.conversation_id);
    assert.deepEqual(current.pending, []); assert.deepEqual(current.model, scheduledOccurrence.job.model);
    const input = await app.session.commit((tx) => tx.submissionByRequest(conversation.id, scheduledOccurrence.id), BACKGROUND_CONTEXT);
    assert.ok(input); assert.equal(input.status, "done");
    const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(page.items.filter((entry) => UserEntry.is(entry)).length, 1);
    assert.equal(app.commands.filter((command) => command.type === "spawn_worker").length, 1);
    assert.equal(app.commands.filter((command) => command.type === "exec").length, 1,
      JSON.stringify(page.items.flatMap((entry) => entry.model?.filter((message) => message.role === "toolResult") ?? [])));
    await runScheduled(scheduledOccurrence, controller.signal, app);
    assert.equal((await app.tasks.list()).length, 1); assert.equal(app.faux.state.callCount, 2);
    assert.equal(app.commands.filter((command) => command.type === "spawn_worker").length, 1);
  } finally {
    controller.abort(); await Promise.allSettled([worker, scheduled]);
    await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
});

test("SIGKILL after scheduled input placement restores its actor without duplicating task, input or host work", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-scheduled-kill-"));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/scheduled-admission-child.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"] });
  let app: Awaited<ReturnType<typeof openScheduled>> | undefined, worker: Promise<unknown> | undefined, scheduled: Promise<void> | undefined;
  const controller = new AbortController();
  try {
    let stderr = ""; child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const lines = createInterface({ input: child.stdout });
    const signal = await lines[Symbol.asyncIterator]().next();
    assert.equal(signal.value, "PLACED", stderr);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve())); child.kill("SIGKILL"); await closed; lines.close();
    app = await openScheduled(directory, "restored");
    const tasks = await app.tasks.list(); assert.equal(tasks.length, 1);
    const original = tasks[0]; assert.ok(original); assert.deepEqual(original.pending, []);
    const originalConversation = await app.tasks.conversation(original.conversation_id);
    const prior = await app.session.commit((tx) => tx.submissionByRequest(originalConversation.id, scheduledOccurrence.id), BACKGROUND_CONTEXT);
    assert.ok(prior);
    app.faux.setResponses([async (context) => {
      assert.match(getCurrentSystemPrompt(context.messages), /FRESH_PROJECT_POLICY_restored/, "A restored native input must use its replacement client's current project guidance");
      return fauxAssistantMessage(fauxToolCall("exec", { program: "example", args: [], cwd: scheduledOccurrence.job.cwd, timeout_seconds: 1 }), { stopReason: "toolUse" });
    }, fauxAssistantMessage("Completed the original scheduled request after recovery.")]);
    scheduled = runScheduled(scheduledOccurrence, controller.signal, app);
    const restored = app;
    await pump(async () => restored.commands.some((command) => command.type === "resume_worker")
      && (await restored.tasks.get(original.id)).worker.state === "bound");
    // Native terminal startup and its run_task connection are asynchronous.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(app.faux.state.callCount, 0, "Recovered inference waits for the actual worker attachment");
    worker = app.worker(original.id, controller);
    await Promise.all([scheduled, worker]);
    const current = await app.tasks.get(original.id), conversation = await app.tasks.conversation(current.conversation_id);
    assert.equal((await app.tasks.list()).length, 1); assert.equal(current.conversation_id, original.conversation_id);
    assert.deepEqual(current.pending, []);
    const recovered = await app.session.commit((tx) => tx.submissionByRequest(conversation.id, scheduledOccurrence.id), BACKGROUND_CONTEXT);
    assert.equal(recovered?.id, prior.id);
    const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(page.items.filter((entry) => UserEntry.is(entry)).length, 1);
    assert.equal(app.commands.filter((command) => command.type === "spawn_worker").length, 0);
    assert.equal(app.commands.filter((command) => command.type === "resume_worker").length, 1);
    assert.equal(app.commands.filter((command) => command.type === "exec").length, 1,
      JSON.stringify(page.items.flatMap((entry) => entry.model?.filter((message) => message.role === "toolResult") ?? [])));
  } finally {
    child.kill("SIGKILL"); controller.abort(); await Promise.allSettled([worker, scheduled]);
    await app?.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
});
