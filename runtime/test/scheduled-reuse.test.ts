import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { UserEntry } from "@earendil-works/pi-durable";
import { BackgroundScheduler } from "../src/background.js";
import { runScheduled } from "../src/scheduled.js";
import { DAY, FakeClock, exampleJob, planned, pump } from "./fixtures/background-runtime.js";
import { openScheduled } from "./fixtures/scheduled-runtime.js";

test("timer and manual runs reuse one attached job conversation with each admitted prompt and model", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-scheduled-reuse-")), clock = new FakeClock();
  const app = await openScheduled(directory, "original", clock), controller = new AbortController();
  let worker: Promise<unknown> | undefined, release = () => {};
  const scheduler = new BackgroundScheduler(app.session, app.registry, app.tasks, {
    plan: async (cadence, after, now) => planned(cadence, after, now), refreshSources: async () => {}, triageSources: async () => {}, collectResources: async () => {},
    runJob: (occurrence, signal, actor) => runScheduled(occurrence, signal, app, actor),
  });
  try {
    const original = exampleJob("original", "ORIGINAL_JOB_POLICY");
    await scheduler.start({ poll_interval_seconds: 60, sources: false, jobs: [original] });
    await pump(async () => (await scheduler.getJob(original.id)).schedules[0]?.next_at !== null);
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {}; const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    app.faux.setResponses([
      async (context, _options, _state, model) => {
        assert.match(getCurrentSystemPrompt(context.messages), /ORIGINAL_JOB_POLICY/);
        assert.equal(model.id, "fixture"); started(); await held;
        return fauxAssistantMessage("First run complete.");
      },
      (context, _options, _state, model) => {
        assert.match(getCurrentSystemPrompt(context.messages), /ORIGINAL_JOB_POLICY/);
        assert.equal(model.id, "fixture"); return fauxAssistantMessage("Queued original run complete.");
      },
      (context, _options, _state, model) => {
        const prompt = getCurrentSystemPrompt(context.messages);
        assert.match(prompt, /UPDATED_JOB_POLICY/); assert.doesNotMatch(prompt, /Task outcome: ORIGINAL_JOB_POLICY/);
        assert.equal(model.id, "fixture-updated");
        assert.equal(app.executions.model(conversationId)?.model_id, "fixture-updated");
        return fauxAssistantMessage("Updated timer run complete.");
      },
    ]);
    const first = await scheduler.runJob({ type: "run_job", request_id: "first", job_id: original.id, schedule_id: null });
    await pump(async () => (await app.tasks.get(first.task_id)).worker.state === "bound");
    const conversationId = (await app.tasks.get(first.task_id)).conversation_id;
    worker = app.worker(first.task_id, controller, app.call, true);
    await firstStarted;
    const second = await scheduler.runJob({ type: "run_job", request_id: "second", job_id: original.id, schedule_id: null });
    assert.equal(second.task_id, first.task_id);
    const updated = { ...original, revision: "updated", prompt: "UPDATED_JOB_POLICY", cwd: join(directory, "updated"), model: { ...original.model, model_id: "fixture-updated" } };
    await mkdir(updated.cwd); await writeFile(join(updated.cwd, "source.txt"), "Contents from the new job directory.");
    await scheduler.syncJobs([updated]);
    assert.equal((await app.tasks.get(first.task_id)).model?.model_id, "fixture", "Editing the file cannot change an in-flight generation");
    release();
    await pump(async () => (await scheduler.status()).pending === 0 && !app.tasks.isRunning(first.task_id));
    clock.advance(DAY);
    await pump(() => app.faux.state.callCount === 3);
    await pump(async () => (await scheduler.status()).pending === 0 && !app.tasks.isRunning(first.task_id));
    const task = await app.tasks.get(first.task_id), conversation = await app.tasks.conversation(task.conversation_id);
    assert.equal(task.conversation_id, conversationId); assert.equal((await app.tasks.list()).length, 1);
    const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(page.items.filter((entry) => UserEntry.is(entry)).length, 3);
    assert.equal(app.commands.filter((command) => command.type === "spawn_worker").length, 1);
    assert.equal(app.commands.filter((command) => command.type === "resume_worker").length, 0);
    assert.deepEqual((await scheduler.status()).errors, []);
    controller.abort(); await worker;
    await app.tasks.update(task.id, (saved) => { saved.model = { ...original.model, model_id: "retired-model" }; });
    app.faux.setResponses([
      (_context, _options, _state, model) => {
        assert.equal(model.id, "fixture-updated");
        return fauxAssistantMessage(fauxToolCall("read_file", { path: "source.txt" }), { stopReason: "toolUse" });
      },
      (context) => {
        assert.ok(context.messages.some((message) => message.role === "toolResult" && message.content.some((part) =>
          part.type === "text" && part.text.includes("Contents from the new job directory."))));
        return fauxAssistantMessage("Reconnected with the current model and directory.");
      },
    ]);
    const resumed = await scheduler.runJob({ type: "run_job", request_id: "reconnected", job_id: original.id, schedule_id: null });
    assert.equal(resumed.task_id, task.id);
    await pump(async () => (await app.tasks.get(task.id)).pending.length > 0 && (await app.tasks.get(task.id)).worker.state === "bound");
    worker = app.worker(task.id); await worker;
    await pump(async () => (await scheduler.status()).pending === 0);
    assert.equal((await app.tasks.get(task.id)).conversation_id, conversationId);
    const read = app.commands.find((command) => command.type === "read_file");
    assert.ok(read?.type === "read_file"); assert.equal(read.path, join(updated.cwd, "source.txt"));
  } finally {
    release(); controller.abort(); await worker?.catch(() => {});
    await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
});
