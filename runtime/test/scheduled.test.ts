import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { UserEntry } from "@earendil-works/pi-durable";
import { BackgroundScheduler } from "../src/background.js";
import { openJobActor, runScheduled } from "../src/scheduled.js";
import type { ScheduledOccurrence } from "../src/generated/ScheduledOccurrence.js";
import type { HostCall } from "../src/tasks.js";
import { createAppTools } from "../src/tools.js";
import { DAY, FakeClock, exampleJob, planned, pump } from "./fixtures/background-runtime.js";
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

for (const scenario of ["absent", "unknown", "wrong", "failed", "foreign"]) {
  test(`recovery with ${scenario} receipt cannot settle an unanswered scheduled input`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-scheduled-receipt-")), app = await openScheduled(directory);
    const controller = new AbortController();
    let worker: Promise<unknown> | undefined;
    try {
      app.faux.setResponses([() => { throw new Error("The original generation failed before any tool"); }]);
      const admission = runScheduled(scheduledOccurrence, controller.signal, app);
      const blocked = assert.rejects(admission, /scheduled turn/);
      await pump(async () => (await app.tasks.list())[0]?.worker.state === "bound");
      const task = (await app.tasks.list())[0]; assert.ok(task);
      worker = app.worker(task.id, controller); await assert.rejects(worker, /did not complete/); await blocked;
      if (scenario === "wrong") {
        await app.tasks.enqueue(task.id, "An independent request.", "other-unanswered", undefined, "follow_up");
        await app.tasks.dispatch(task.id, await app.tasks.workerHost(task.id), app.call);
        app.faux.setResponses([() => { throw new Error("The independent request also failed before tools"); }]);
        worker = app.worker(task.id, controller); await assert.rejects(worker, /did not complete/);
      }
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("record_task", {
          summary: "Reviewed the earlier failure.",
          ...(scenario === "foreign" ? { task_id: task.id } : {}),
          state: { state: "waiting", actor: "Upstream check", next_check: null },
          ...(scenario === "absent" ? {} : { reconciles_input: scenario === "wrong" ? "other-unanswered"
            : scenario === "unknown" ? "unknown-request" : scheduledOccurrence.id }),
        }), { stopReason: "toolUse" }),
        (context) => {
          if (scenario === "unknown" || scenario === "foreign") assert.ok(context.messages.some((message) => message.role === "toolResult" && message.isError));
          if (scenario === "failed") throw new Error("The recovery failed after claiming reconciliation");
          return fauxAssistantMessage("The later request finished.");
        },
      ]);
      if (scenario === "foreign") {
        const root = await app.session.root(BACKGROUND_CONTEXT);
        const unbind = app.executions.bind(root.id.toString(), { cwd: "/workspace/example", hosts: [], call: app.call });
        try {
          await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [createAppTools(app.tasks, app.executions).main] }, BACKGROUND_CONTEXT);
          const submission = await root.submit({ type: "input", content: "Review another conversation's failure.", requestId: "foreign-recovery" }, BACKGROUND_CONTEXT);
          assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
        } finally { unbind(); }
      } else {
        await app.tasks.enqueue(task.id, "Review the previous failure.", "recovery", undefined, "follow_up");
        await app.tasks.dispatch(task.id, await app.tasks.workerHost(task.id), app.call);
        worker = app.worker(task.id, controller);
        if (scenario === "failed") await assert.rejects(worker, /did not complete/); else await worker;
      }
      await assert.rejects(runScheduled(scheduledOccurrence, controller.signal, app, task.id), /scheduled turn/);
      const claimed = (await app.sources.events({ provider: "task_outcomes", thread_id: task.id, limit: 100 }))
        .find((event) => event.outcome?.reconciliation !== undefined)?.outcome;
      assert.equal(claimed !== undefined, scenario === "failed" || scenario === "wrong");
      if (claimed?.tool_call_id !== null && claimed?.tool_call_id !== undefined) {
        await assert.rejects(app.tasks.record(task.id, { summary: "Stale invocation", state: { state: "open" },
          reconciles_input: scheduledOccurrence.id }, { conversation_id: task.conversation_id,
          call_id: claimed.tool_call_id, settled: false }), /current native recovery turn/);
      }
    } finally {
      controller.abort(); await worker?.catch(() => {});
      await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const recoveredState of ["waiting", "resolved"]) {
  test(recoveredState === "waiting"
    ? "explicit recovery settles an unanswered occurrence after reopen while its task still waits, without replaying its effect"
    : "legacy resolved recovery settles an unanswered occurrence after reopen without a receipt or repeated effect", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-scheduled-reconcile-")), clock = new FakeClock();
    let app = await openScheduled(directory, "original", clock), worker: Promise<unknown> | undefined;
    const controller = new AbortController(), effectPath = join(directory, "effect.txt");
    let first: ScheduledOccurrence | undefined, release = () => {}, allowVerification = () => {}, allowFollowup = () => {};
    const background = () => {
      const current = app;
      return new BackgroundScheduler(current.session, current.registry, current.tasks, {
        plan: async (cadence, after, now) => planned(cadence, after, now),
        refreshSources: async () => {}, triageSources: async () => {}, collectResources: async () => {},
        runJob: async (occurrence, signal, actor) => { first ??= occurrence; await runScheduled(occurrence, signal, current, actor); },
      });
    };
    const hostCall: HostCall = async (command) => {
      if (command.type === "exec" && command.program === "perform-effect") {
        app.commands.push(command); await appendFile(effectPath, "performed once\n");
        return { type: "process", exit_code: 0, stdout: "Effect recorded", stderr: "", truncated: false };
      }
      if (command.type === "exec" && command.program === "verify-effect") {
        app.commands.push(command);
        return { type: "process", exit_code: 0, stdout: await readFile(effectPath, "utf8"), stderr: "", truncated: false };
      }
      return app.call(command);
    };
    let scheduler = background();
    try {
      let started = () => {}; const streaming = new Promise<void>((resolve) => { started = resolve; });
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("exec", { program: "perform-effect", args: [] }), { stopReason: "toolUse" }),
        async (_context, options) => {
          const signal = options?.signal; assert.ok(signal); started();
          await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
          return fauxAssistantMessage("Discarded after interruption");
        },
      ]);
      await scheduler.start({ poll_interval_seconds: 60, sources: false, jobs: [exampleJob()] });
      await pump(async () => (await scheduler.getJob("example-review")).schedules[0]?.next_at !== null);
      clock.advance(DAY);
      await pump(async () => (await app.tasks.list())[0]?.worker.state === "bound");
      const task = (await app.tasks.list())[0]; assert.ok(task); assert.ok(first); const occurrence = first;
      const conversation = await app.tasks.conversation(task.conversation_id);
      worker = app.worker(task.id, controller, hostCall);
      const failedWorker = assert.rejects(worker, /did not complete/);
      await streaming; assert.equal(await readFile(effectPath, "utf8"), "performed once\n");
      await conversation.abort(BACKGROUND_CONTEXT); await failedWorker;
      const original = await app.session.commit((tx) => tx.submissionByRequest(conversation.id, occurrence.id), BACKGROUND_CONTEXT);
      assert.ok(original); assert.equal(original.status, "unanswered");
      await pump(async () => (await scheduler.status()).errors.some((error) => /scheduled turn/.test(error.message)));
      await assert.rejects(runScheduled(occurrence, controller.signal, app, task.id), /scheduled turn/);
      clock.advance(DAY);
      await pump(async () => (await scheduler.status()).pending === 2);
      assert.equal((await app.tasks.list()).length, 1, "The unanswered occurrence retains its serial job lane");

      await app.tasks.enqueue(task.id, "Verify the original effect before resolving this same task.", "reconcile-effect", undefined, "follow_up");
      await app.tasks.dispatch(task.id, await app.tasks.workerHost(task.id), app.call);
      let reconciled = () => {}; const resolving = new Promise<void>((resolve) => { reconciled = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let verifying = () => {}; const verification = new Promise<void>((resolve) => { verifying = resolve; });
      const verificationGate = new Promise<void>((resolve) => { allowVerification = resolve; });
      app.faux.setResponses([
        async () => { verifying(); await verificationGate;
          return fauxAssistantMessage(fauxToolCall("exec", { program: "verify-effect", args: [] }), { stopReason: "toolUse" }); },
        (context) => {
          assert.ok(context.messages.some((message) => message.role === "toolResult" &&
            message.content.some((part) => part.type === "text" && part.text.includes("performed once"))));
          return fauxAssistantMessage(fauxToolCall("record_task", { summary: "Verified the original effect occurred once.",
            ...(recoveredState === "waiting" ? { reconciles_input: occurrence.id } : {}),
            state: recoveredState === "waiting" ? { state: "waiting", actor: "Upstream check", next_check: null }
              : { state: "resolved", evidence: "Read back the original effect receipt; no replay is needed." } }), { stopReason: "toolUse" });
        },
        async () => { reconciled(); await gate; return fauxAssistantMessage("The original effect is verified and this task is reconciled."); },
      ]);
      worker = app.worker(task.id, controller, hostCall); await verification;
      await conversation.submit({ type: "input", content: "Keep the existing upstream wait after verifying the effect.",
        requestId: "recovery-steering", whenBusy: "steer" }, BACKGROUND_CONTEXT);
      allowVerification(); await resolving;
      assert.equal((await app.tasks.get(task.id)).state.state, recoveredState);
      assert.equal(app.tasks.isRunning(task.id), true);
      await assert.rejects(runScheduled(occurrence, controller.signal, app, task.id), /scheduled turn/);
      release(); await worker;
      const receipt = (await app.sources.events({ provider: "task_outcomes", thread_id: task.id, limit: 100 }))
        .find((event) => event.outcome?.reconciliation !== undefined)?.outcome?.reconciliation;
      assert.equal(await app.session.commit((tx) => app.tasks.canReleaseIn(tx, task.id), BACKGROUND_CONTEXT), recoveredState === "resolved",
        "Resource release still requires task resolution");
      // A native follow-up can outlive the application worker; it still owns the
      // conversation until it and its queued input finish.
      let following = () => {}; const followingStarted = new Promise<void>((resolve) => { following = resolve; });
      const followupGate = new Promise<void>((resolve) => { allowFollowup = resolve; });
      app.faux.setResponses([async () => { following(); await followupGate; return fauxAssistantMessage("Checked the follow-up."); },
        fauxAssistantMessage("Checked the queued follow-up.")]);
      const followup = await conversation.submit({ type: "input", content: "Review the upstream check.", requestId: "native-followup" }, BACKGROUND_CONTEXT);
      await followingStarted;
      const queued = await conversation.submit({ type: "input", content: "Retain the upstream wait.", requestId: "queued-followup", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
      assert.equal(app.tasks.isRunning(task.id), false);
      assert.equal((await queued.status(BACKGROUND_CONTEXT)).status, "queued");
      await assert.rejects(runScheduled(occurrence, controller.signal, app, task.id), /scheduled turn/);
      allowFollowup(); await followup.wait(BACKGROUND_CONTEXT); await queued.wait(BACKGROUND_CONTEXT);
      const owningHost = await app.tasks.workerHost(task.id);
      await assert.rejects(app.tasks.dispatch(task.id, owningHost, async () => ({ type: "creation_uncertain", session_id: "session:22222222-2222-4222-8222-222222222222" })), /needs reconciliation/);
      assert.equal((await app.tasks.get(task.id)).worker.state, "resume_uncertain");
      await assert.rejects(runScheduled(occurrence, controller.signal, app, task.id), /scheduled turn/);
      await app.tasks.dispatch(task.id, owningHost, async (command) => {
        assert.equal(command.type, "on_node");
        if (command.type !== "on_node") throw new Error("Reconcile the existing worker allocation");
        assert.equal(command.command.type, "inspect_worker");
        return { type: "worker_presence", presence: { state: "present", running: true } };
      });
      await app.session.close(BACKGROUND_CONTEXT); app = await openScheduled(directory, "restored", clock); scheduler = background();
      await scheduler.start({ poll_interval_seconds: 60, sources: false, jobs: [exampleJob()] });
      await runScheduled(occurrence, controller.signal, app, task.id);
      assert.equal((await app.tasks.get(task.id)).state.state, recoveredState);
      if (recoveredState === "waiting") {
        assert.equal(receipt?.original.submission_id, original.id.toString());
        assert.deepEqual(receipt?.recovery_inputs.map((input) => input.request_id), ["reconcile-effect", "recovery-steering"]);
      } else assert.equal(receipt, undefined);
      clock.advance(3_600_000);
      await pump(async () => (await app.tasks.get(task.id)).pending.length > 0);
      app.faux.setResponses([fauxAssistantMessage("The next queued review completed.")]);
      worker = app.worker(task.id, controller, hostCall); await worker;
      await pump(async () => (await scheduler.status()).pending === 0);
      assert.deepEqual((await scheduler.status()).errors, []);
      assert.equal(await readFile(effectPath, "utf8"), "performed once\n");
      assert.equal((await app.tasks.list()).length, 1);
      const restored = await app.tasks.conversation((await app.tasks.get(task.id)).conversation_id);
      const retained = await app.session.commit((tx) => tx.submissionByRequest(restored.id, occurrence.id), BACKGROUND_CONTEXT);
      assert.equal(retained?.id, original.id); assert.equal(retained?.status, "unanswered");
      const page = await restored.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      assert.equal(page.items.filter((entry) => UserEntry.is(entry)).length, 6, "The next occurrence joins the original input, explicit recovery, steering and native follow-ups");
      assert.equal(app.commands.filter((command) => command.type === "exec" && command.program === "perform-effect").length, 0);
    } finally {
      release(); allowVerification(); allowFollowup(); controller.abort(); await worker?.catch(() => {});
      await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
    }
  });
}

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

test("job migration adopts only an owned open Rex chat and retains unknown presence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-scheduled-adopt-")), app = await openScheduled(directory);
  try {
    const job = exampleJob();
    const host = await app.environment.defaultHost(await app.environment.hosts(job.cwd, null, [])); assert.ok(host);
    const unrelated = await app.tasks.create({ title: job.title, outcome: "An ordinary interactive task" });
    await app.tasks.dispatch(unrelated.id, host, app.call);
    assert.equal(await openJobActor(job, app.tasks, app.call), undefined, "A matching title does not grant job ownership");
    const owned = await app.tasks.create({ title: job.title, outcome: job.prompt,
      sources: [{ provider: "scheduled_jobs", account: "local", thread_id: job.id }] });
    await app.tasks.dispatch(owned.id, host, app.call);
    let inspections = 0;
    const presence: HostCall = async (command) => {
      assert.equal(command.type, "on_node"); inspections += 1;
      return { type: "worker_presence", presence: { state: "present", running: true } };
    };
    assert.equal(await openJobActor(job, app.tasks, presence), owned.id); assert.equal(inspections, 1);
    await assert.rejects(openJobActor(job, app.tasks, async () => ({ type: "failed", message: "Host offline" })), /could not be inspected/);
    assert.equal(await openJobActor(job, app.tasks, async () => ({ type: "worker_presence", presence: { state: "missing_session" } })), undefined);
    assert.equal(app.commands.filter((command) => command.type === "spawn_worker").length, 2, "Inspection creates no replacements");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
