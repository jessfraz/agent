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
import { ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { BackgroundScheduler } from "../src/background.js";
import { runScheduled } from "../src/scheduled.js";
import type { ScheduledOccurrence } from "../src/generated/ScheduledOccurrence.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import { DAY, START, exampleJob, FakeClock, openBackground, planned, pump } from "./fixtures/background-runtime.js";
import { openManual } from "./fixtures/manual-runtime.js";
import { openScheduled } from "./fixtures/scheduled-runtime.js";

function request(requestId: string, scheduleId: string | null = null): Extract<RuntimeCommand, { type: "run_job" }> {
  return { type: "run_job", job_id: "example-review", schedule_id: scheduleId, request_id: requestId };
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("manual admissions retain every requested run in the existing serial job lane without changing timers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manual-lane-")), clock = new FakeClock();
  const releases = [gate(), gate(), gate(), gate()], runs: ScheduledOccurrence[] = [];
  let active = 0, maximum = 0;
  const app = await openBackground(directory, clock, { runJob: async (occurrence) => {
    const current = releases[runs.length]; runs.push(occurrence); active += 1; maximum = Math.max(maximum, active);
    try { if (current !== undefined) await current.promise; } finally { active -= 1; }
  } });
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + DAY);
    const before = await app.scheduler.getJob("example-review");
    const first = await app.scheduler.runJob(request("first"));
    await pump(() => runs.length === 1);
    const second = await app.scheduler.runJob(request("second")), third = await app.scheduler.runJob(request("third"));
    assert.equal(new Set([first.task_id, second.task_id, third.task_id]).size, 3);
    assert.deepEqual((await app.tasks.get(second.task_id)).scheduled_run, second);
    assert.equal((await app.tasks.get(second.task_id)).worker.state, "unassigned", "A queued run returns a task before its worker starts");
    assert.deepEqual((await app.scheduler.getJob("example-review")).schedules, before.schedules);
    clock.advance(2 * DAY);
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.last_at === START + 2 * DAY);
    await app.scheduler.syncJobs([]);
    assert.deepEqual(await app.scheduler.runJob(request("second")), second, "Replay survives catalog removal");
    releases[0]?.release(); await pump(() => runs.length === 2);
    releases[1]?.release(); await pump(() => runs.length === 3);
    releases[2]?.release(); await pump(() => runs.length === 4);
    assert.deepEqual(runs.slice(0, 3).map((run) => run.id), ["manual:first", "manual:second", "manual:third"]);
    assert.ok(runs.every((run) => run.job.revision === "one"));
    assert.equal(runs[3]?.scheduled_at, START + 2 * DAY); assert.equal(maximum, 1);
    assert.equal((await app.scheduler.status()).triggers, 2, "Job removal leaves both built-in triggers intact");
    releases[3]?.release();
  } finally { for (const release of releases) release.release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("manual request replay precedes current catalog validation and conflicting identities never mutate task state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manual-replay-")), clock = new FakeClock();
  let executions = 0;
  const app = await openBackground(directory, clock, { runJob: async () => { executions += 1; } });
  try {
    const original = exampleJob();
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [original] });
    await assert.rejects(app.scheduler.runJob({ ...request("missing"), job_id: "unknown" }), /Unknown scheduled job/);
    await assert.rejects(app.scheduler.runJob(request("invalid", "unknown")), /Unknown schedule/);
    assert.equal((await app.tasks.list()).length, 0);
    const receipts = await Promise.all(Array.from({ length: 5 }, () => app.scheduler.runJob(request("replayed"))));
    assert.equal(new Set(receipts.map((receipt) => receipt.task_id)).size, 1);
    await pump(async () => (await app.scheduler.status()).pending === 0);
    assert.equal(executions, 1);
    const updated = exampleJob("two", "A newly reviewed prompt.");
    const schedule = updated.schedules[0]; assert.ok(schedule);
    updated.schedules.push({ ...schedule, id: "research", prompt: "Research only." });
    await app.scheduler.syncJobs([updated]);
    await assert.rejects(app.scheduler.runJob(request("ambiguous")), /daily, research/);
    assert.deepEqual(await app.scheduler.runJob(request("replayed")), receipts[0]);
    await assert.rejects(app.scheduler.runJob(request("replayed", "research")), /another selection/);
    await assert.rejects(app.scheduler.runJob({ ...request("replayed"), job_id: "different" }), /another selection/);
    await app.scheduler.syncJobs([]);
    assert.deepEqual(await app.scheduler.runJob(request("replayed")), receipts[0]);
    assert.equal((await app.tasks.list()).length, 1); assert.equal(executions, 1);
    const only = (await app.tasks.list())[0]; assert.ok(only);
    assert.equal(only.scheduled_run?.revision, "one"); assert.equal(only.outcome, original.prompt);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("manual failure retries preserve the original task, request and immutable work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manual-retry-")), clock = new FakeClock();
  const attempts: ScheduledOccurrence[] = [];
  const app = await openBackground(directory, clock, { runJob: async (occurrence) => {
    attempts.push(occurrence); if (attempts.length === 1) throw new Error("Synthetic host unavailable");
  } });
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    const receipt = await app.scheduler.runJob(request("retry"));
    await pump(async () => (await app.scheduler.status()).errors.some((error) => error.message === "Synthetic host unavailable"));
    const updated = exampleJob("two", "Use later instructions."); await app.scheduler.syncJobs([updated]);
    clock.advance(60_000);
    await pump(async () => attempts.length === 2 && (await app.scheduler.status()).pending === 0);
    assert.equal(attempts[0]?.id, attempts[1]?.id); assert.equal(attempts[1]?.job.revision, "one");
    assert.equal((await app.tasks.list()).length, 1); assert.deepEqual((await app.tasks.get(receipt.task_id)).scheduled_run, receipt);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

async function killAdmission(directory: string, mode: "api" | "tool"): Promise<string> {
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/manual-admission-child.js", import.meta.url)), directory, mode],
    { stdio: ["pipe", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
  const lines = createInterface({ input: child.stdout });
  try {
    const line = await lines[Symbol.asyncIterator]().next();
    assert.equal(line.done, false, errors);
    if (typeof line.value !== "string") throw new Error("Manual fixture task identity missing");
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve())); child.kill("SIGKILL"); await closed;
    return line.value;
  } finally { child.kill("SIGKILL"); lines.close(); }
}

test("manual admission survives SIGKILL and catalog removal before queued execution finishes", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manual-kill-"));
  let app: Awaited<ReturnType<typeof openManual>> | undefined;
  try {
    const id = await killAdmission(directory, "api"); app = await openManual(directory);
    const stored = (await app.tasks.get(id)).scheduled_run; assert.ok(stored);
    await app.scheduler.syncJobs([]);
    assert.deepEqual(await app.scheduler.runJob(request("crash-request")), stored);
    const restored = app;
    await pump(async () => (await restored.receipts())?.jobs.length === 1 && (await restored.scheduler.status()).pending === 0);
    assert.equal((await app.tasks.list()).length, 1); assert.equal(app.workCalls(), 1);
    assert.equal((await app.receipts())?.jobs[0]?.job.revision, "one");
  } finally { app?.unbind(); await app?.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native run_job tool memo replays its original admission after SIGKILL without another task or run", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manual-tool-kill-"));
  let app: Awaited<ReturnType<typeof openManual>> | undefined;
  try {
    const id = await killAdmission(directory, "tool"); app = await openManual(directory);
    const original = (await app.tasks.get(id)).scheduled_run; assert.ok(original);
    await app.scheduler.syncJobs([]);
    app.faux.setResponses([fauxAssistantMessage("The existing run was admitted; its task owns progress.")]);
    const input = await app.root.submit({ type: "input", content: "Run the example review now.", requestId: "manual-tool-input" }, BACKGROUND_CONTEXT);
    assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "done");
    const entries = await app.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => UserEntry.is(entry)).length, 1);
    const result = entries.items.find((entry) => ToolResultEntry.is(entry)); assert.ok(result);
    const content = result.model?.filter((message) => message.role === "toolResult").flatMap((message) => message.content);
    assert.ok(content?.some((part) => part.type === "text" && part.text.includes(original.task_id)));
    assert.equal((await app.tasks.list()).length, 1); assert.equal(app.workCalls(), 0);
    assert.equal((await app.receipts())?.jobs.length, 1);
  } finally { app?.unbind(); await app?.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("natural job discovery is compact and run_job returns admission while its task remains queued", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manual-tools-"));
  const app = await openManual(directory);
  try {
    const job = exampleJob("one", "FULL_PROMPT_PRIVATE_TO_READ_JOB"); await app.scheduler.syncJobs([job]);
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("list_jobs", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_job", { job_id: job.id }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("run_job", { job_id: job.id }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The task now owns this requested run."),
    ]);
    assert.equal((await (await app.root.submit({ type: "input", content: "Find the example review and run it now." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    const page = await app.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const results = page.items.flatMap((entry) => entry.model?.filter((message) => message.role === "toolResult") ?? []);
    const list = results.find((message) => message.toolName === "list_jobs"), read = results.find((message) => message.toolName === "read_job");
    assert.ok(list); assert.ok(read);
    assert.equal(JSON.stringify(list).includes(job.prompt), false); assert.equal(JSON.stringify(read).includes(job.prompt), true);
    assert.equal((await app.tasks.list()).length, 1);
  } finally { app.unbind(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a manually admitted task executes its reviewed focus through the actual scheduled worker lifecycle", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manual-worker-"));
  const app = await openScheduled(directory), controller = new AbortController();
  let worker: Promise<unknown> | undefined;
  const scheduler = new BackgroundScheduler(app.session, app.registry, app.tasks, {
    plan: async (cadence, after, now) => planned(cadence, after, now), refreshSources: async () => {}, collectResources: async () => {},
    runJob: (occurrence, signal) => runScheduled(occurrence, signal, app),
  });
  try {
    const job = exampleJob("reviewed", "MANUAL_REVIEWED_DOMAIN_POLICY"); job.cwd = "/workspace/manual-review";
    const schedule = job.schedules[0]; assert.ok(schedule); schedule.focus = "Research"; schedule.prompt = "MANUAL_REVIEWED_FOCUS";
    await scheduler.syncJobs([job]);
    app.faux.setResponses([async (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      assert.match(prompt, /MANUAL_REVIEWED_DOMAIN_POLICY/); assert.match(prompt, /FRESH_GLOBAL_POLICY/); assert.match(prompt, /FRESH_PROJECT_POLICY/);
      assert.equal(getCurrentTools(context.messages).some((tool) => tool.name === "run_job"), false, "A job worker cannot enqueue another run into its own lane");
      const inputs = context.messages.filter((message) => message.role === "user").flatMap((message) =>
        typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : []));
      assert.ok(inputs.some((input) => input.includes("MANUAL_REVIEWED_FOCUS")));
      return fauxAssistantMessage(fauxToolCall("exec", { program: "example", args: [], timeout_seconds: 1 }), { stopReason: "toolUse" });
    }, fauxAssistantMessage("The requested manual review completed.")]);
    const receipt = await scheduler.runJob(request("real-worker"));
    assert.deepEqual((await app.tasks.get(receipt.task_id)).scheduled_run, receipt);
    await pump(async () => {
      assert.deepEqual((await scheduler.status()).errors, [], "Manual admission must reach its ordinary task handoff");
      return (await app.tasks.get(receipt.task_id)).worker.state === "bound";
    });
    worker = app.worker(receipt.task_id, controller); await worker;
    await pump(async () => (await scheduler.status()).pending === 0);
    const task = await app.tasks.get(receipt.task_id), conversation = await app.tasks.conversation(task.conversation_id);
    assert.deepEqual(task.model, job.model); assert.ok(task.worker.state === "bound"); assert.equal(task.worker.host.cwd, job.cwd);
    const input = await app.session.commit((tx) => tx.submissionByRequest(conversation.id, "manual:real-worker"), BACKGROUND_CONTEXT);
    assert.equal(input?.status, "done");
    const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(page.items.filter((entry) => UserEntry.is(entry)).length, 1);
    const effect = app.commands.find((command) => command.type === "exec"); assert.ok(effect?.type === "exec"); assert.equal(effect.cwd, job.cwd);
    assert.deepEqual(await scheduler.runJob(request("real-worker")), receipt);
    assert.equal((await app.tasks.list()).length, 1); assert.equal(app.commands.filter((command) => command.type === "exec").length, 1);
  } finally { controller.abort(); await worker?.catch(() => {}); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
