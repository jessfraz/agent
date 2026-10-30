import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SourceJournal } from "../src/sources.js";
import type { ScheduledOccurrence } from "../src/generated/ScheduledOccurrence.js";
import { DAY, START, exampleJob, FakeClock, openBackground, planned, pump } from "./fixtures/background-runtime.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function untilReleased(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { reject(new Error("Background invocation stopped")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => { signal.removeEventListener("abort", abort); resolve(); }, reject);
  });
}
async function killAt(directory: string, boundary: "before" | "after"): Promise<void> {
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/background-kill-child.js", import.meta.url)), directory, boundary],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const lines = createInterface({ input: child.stdout });
  try {
    const signal = await lines[Symbol.asyncIterator]().next();
    assert.equal(signal.done, false, stderr); assert.equal(signal.value, boundary === "before" ? "BEFORE" : "AFTER");
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await closed;
  } finally { lines.close(); child.kill("SIGKILL"); }
}

test("sources, resource collection and jobs share Pi deadlines and coalesce missed occurrences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-"));
  const clock = new FakeClock(); const app = await openBackground(directory, clock);
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    await pump(async () => (await app.receipts())?.sources === 1 && (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + DAY);
    assert.equal((await app.receipts())?.jobs.length, 0);
    clock.advance(DAY - 1);
    await pump(async () => (await app.receipts())?.sources === 2);
    assert.equal((await app.receipts())?.jobs.length, 0);
    clock.advance(1);
    await pump(async () => (await app.receipts())?.jobs.length === 1);
    assert.equal((await app.receipts())?.jobs[0]?.scheduled_at, START + DAY);
    clock.advance(5 * DAY);
    await pump(async () => (await app.receipts())?.jobs.length === 2);
    assert.equal((await app.receipts())?.jobs[1]?.scheduled_at, START + 6 * DAY);
    const status = await app.scheduler.getJob("example-review");
    assert.equal(status.schedules[0]?.last_at, START + 6 * DAY);
    assert.equal(status.schedules[0]?.next_at, START + 7 * DAY);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("held source judgment does not stop native polling or admit concurrent judgments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-source-judgment-")), clock = new FakeClock();
  const held = gate(); let reads = 0, judgments = 0, active = 0, maximum = 0;
  const callbacks = {
    refreshSources: async () => {
      const previous = (await sources.states()).find((state) => state.source.provider === "mail");
      reads += 1;
      await sources.admit({ source: { provider: "mail", account: "example" }, checkpoint: { value: String(reads) },
        coverage: { status: "complete" }, events: [{ id: String(reads), version: "one",
          source: { provider: "mail", account: "example", thread_id: String(reads) }, title: "Example update", text: "New source evidence" }] },
      previous?.checkpoint ?? null);
    },
    triageSources: async (signal: AbortSignal) => {
      judgments += 1; active += 1; maximum = Math.max(maximum, active);
      try { if (judgments === 1) await untilReleased(held.promise, signal); }
      finally { active -= 1; }
    },
  };
  const app = await openBackground(directory, clock, callbacks), sources = new SourceJournal(app.session, app.tasks);
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    await pump(() => reads === 1);
    await assert.doesNotReject(pump(() => judgments === 1), "Polling must schedule independent source judgment");
    for (const expected of [2, 3]) {
      clock.advance(60_000);
      await pump(async () => (await sources.events({ provider: "mail" })).length === expected);
    }
    assert.equal(judgments, 1, "A held judgment retains its serial lane while polls keep admitting evidence");
    const receipt = await app.scheduler.runJob({ type: "run_job", job_id: "example-review", schedule_id: null, request_id: "while-judging" });
    await pump(async () => (await app.receipts())?.jobs.length === 1);
    assert.equal((await app.receipts())?.jobs[0]?.id, "manual:" + receipt.request_id);
    await pump(async () => (await app.scheduler.status()).pending === 2);
    held.release(); await pump(async () => judgments === 2 && (await app.scheduler.status()).pending === 0);
    assert.equal(maximum, 1);
    assert.equal((await sources.states()).find((state) => state.source.provider === "mail")?.checkpoint?.value, "3");
  } finally { held.release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a failed source judgment keeps its native retry identity across reopen while polling advances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-judgment-retry-")), clock = new FakeClock();
  let judgments = 0;
  let app = await openBackground(directory, clock, { triageSources: async () => {
    judgments += 1; throw new Error("Example judgment needs retry");
  } });
  try {
    const settings = { poll_interval_seconds: 60, sources: true, jobs: [] };
    await app.scheduler.start(settings);
    await pump(async () => (await app.scheduler.status()).errors.some((error) => error.key.type === "builtin" &&
      error.key.name === "source_triage" && error.message === "Example judgment needs retry"));
    const failed = (await app.session.inspect(BACKGROUND_CONTEXT)).tasks.find(({ record, state }) => {
      const input = record.input;
      return state.kind === "sleeping" && record.kind === "agent.background" && input !== null && typeof input === "object" &&
        "type" in input && input.type === "work" && "work" in input && input.work !== null && typeof input.work === "object" &&
        "type" in input.work && input.work.type === "source_triage";
    });
    assert.ok(failed);
    await pump(async () => (await app.receipts())?.sources === 1);
    await app.session.close(BACKGROUND_CONTEXT);
    app = await openBackground(directory, clock, { triageSources: async () => { judgments += 1; } });
    await app.scheduler.start(settings);
    assert.equal((await app.session.commit((tx) => tx.task(failed.record.id), BACKGROUND_CONTEXT))?.id, failed.record.id);
    clock.advance(60_000);
    await pump(async () => judgments >= 2 && (await app.receipts())?.sources === 2 && (await app.scheduler.status()).pending === 0);
    const retried = await app.session.commit((tx) => tx.task(failed.record.id), BACKGROUND_CONTEXT);
    assert.equal(retried?.state.status, "terminal");
    assert.equal((await app.scheduler.status()).errors.length, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("timer and manual runs reuse one owned job actor across reopen while equal titles stay separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-actor-")), clock = new FakeClock();
  const job = exampleJob(), other = { ...exampleJob(), id: "other-review" };
  const actorId = "99999999-9999-4999-8999-999999999999";
  const runs: { job: string; actor: string }[] = []; let lookups = 0;
  const runJob = async (occurrence: ScheduledOccurrence, _signal: AbortSignal, actor: string) => { runs.push({ job: occurrence.job.id, actor }); };
  let app = await openBackground(directory, clock, { runJob, jobActor: async (candidate) => {
    lookups += 1; return candidate.id === job.id ? actorId : undefined;
  } });
  try {
    const owned = await app.tasks.create({ id: actorId, title: job.title, outcome: job.prompt, model: job.model,
      sources: [{ provider: "scheduled_jobs", account: "local", thread_id: job.id }] });
    await app.scheduler.start({ poll_interval_seconds: 60, sources: false, jobs: [job, other] });
    await pump(async () => (await app.scheduler.getJob(job.id)).schedules[0]?.next_at === START + DAY);
    const first = await app.scheduler.runJob({ type: "run_job", job_id: job.id, schedule_id: null, request_id: "first" });
    const separate = await app.scheduler.runJob({ type: "run_job", job_id: other.id, schedule_id: null, request_id: "other" });
    await pump(async () => runs.length === 2 && (await app.scheduler.status()).pending === 0);
    assert.equal(first.task_id, actorId); assert.notEqual(separate.task_id, actorId);
    clock.advance(DAY); await pump(async () => runs.length === 4 && (await app.scheduler.status()).pending === 0);
    assert.ok(runs.filter((run) => run.job === job.id).every((run) => run.actor === actorId));
    assert.ok(runs.filter((run) => run.job === other.id).every((run) => run.actor === separate.task_id));
    assert.equal(lookups, 2);
    await app.session.close(BACKGROUND_CONTEXT);
    app = await openBackground(directory, clock, { runJob, jobActor: async () => { throw new Error("A bound job must not select another actor"); } });
    await app.scheduler.start({ poll_interval_seconds: 60, sources: false, jobs: null });
    const later = await app.scheduler.runJob({ type: "run_job", job_id: job.id, schedule_id: null, request_id: "later" });
    await pump(async () => runs.length === 5 && (await app.scheduler.status()).pending === 0);
    assert.equal(later.task_id, actorId); assert.equal((await app.tasks.get(actorId)).conversation_id, owned.conversation_id);
    assert.equal((await app.tasks.list()).length, 2);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("an occurrence's native actor memo and immutable snapshot survive a failed attempt and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-actor-retry-")), clock = new FakeClock();
  const attempts: { occurrence: ScheduledOccurrence; actor: string }[] = [];
  let app = await openBackground(directory, clock, { runJob: async (occurrence, _signal, actor) => {
    attempts.push({ occurrence, actor }); throw new Error("An admitted effect needs reconciliation");
  } });
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: false, jobs: [exampleJob()] });
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + DAY);
    clock.advance(DAY);
    await pump(async () => (await app.scheduler.status()).errors.some((error) => error.message === "An admitted effect needs reconciliation"));
    const original = attempts[0]; assert.ok(original);
    const work = (await app.session.commit((tx) => tx.scanTasks({ kind: "agent.background" }, 100), BACKGROUND_CONTEXT)).items
      .find((task) => task.memos?.job_actor_task_id === original.actor); assert.ok(work);
    await app.scheduler.syncJobs([exampleJob("two", "Use the later reviewed instructions.")]);
    await app.session.close(BACKGROUND_CONTEXT);
    app = await openBackground(directory, clock, { jobActor: async () => { throw new Error("The native memo already owns actor selection"); },
      runJob: async (occurrence, _signal, actor) => { attempts.push({ occurrence, actor }); } });
    const restored = await app.session.commit((tx) => tx.task(work.id), BACKGROUND_CONTEXT);
    assert.equal(restored?.memos?.job_actor_task_id, original.actor);
    await app.scheduler.start({ poll_interval_seconds: 60, sources: false, jobs: null });
    clock.advance(60_000); await pump(async () => attempts.length === 2 && (await app.scheduler.status()).pending === 0);
    assert.deepEqual(attempts[1], original); assert.equal((await app.tasks.list()).length, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("job-only synchronization diffs definitions without altering built-in source deadlines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-"));
  const clock = new FakeClock(); const app = await openBackground(directory, clock);
  try {
    const job = exampleJob();
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [job] });
    await pump(async () => (await app.receipts())?.sources === 1 && (await app.scheduler.getJob(job.id)).schedules[0]?.next_at !== null);
    assert.deepEqual(await app.scheduler.syncJobs([job]), { added: 0, updated: 0, removed: 0, unchanged: 1 });
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: null });
    assert.equal((await app.scheduler.listJobs())[0]?.job.id, job.id, "A service without configured roots retains explicitly synchronized files");
    clock.advance(30_000);
    const updated = exampleJob("two", "Review the updated example.");
    assert.deepEqual(await app.scheduler.syncJobs([updated]), { added: 0, updated: 1, removed: 0, unchanged: 0 });
    assert.equal((await app.scheduler.getJob(job.id)).job.prompt, updated.prompt);
    clock.advance(30_000);
    await pump(async () => (await app.receipts())?.sources === 2);
    assert.deepEqual(await app.scheduler.syncJobs([]), { added: 0, updated: 0, removed: 1, unchanged: 0 });
    assert.deepEqual(await app.scheduler.listJobs(), []);
    assert.equal((await app.scheduler.status()).triggers, 3);
    await assert.rejects(app.scheduler.getJob(job.id), /Unknown scheduled job/);
    await assert.rejects(app.scheduler.syncJobs([job, job]), /Duplicate/);
    clock.advance(60_000);
    await pump(async () => (await app.receipts())?.sources === 3);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("replacing a timer preserves admitted model snapshots and serializes pending runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-"));
  const clock = new FakeClock(), releases = [gate(), gate(), gate()];
  const runs: ScheduledOccurrence[] = [];
  let concurrent = 0, maximum = 0;
  const app = await openBackground(directory, clock, { runJob: async (occurrence, signal) => {
    const release = releases[runs.length]; runs.push(occurrence); concurrent += 1; maximum = Math.max(maximum, concurrent);
    try { if (release !== undefined) await untilReleased(release.promise, signal); }
    finally { concurrent -= 1; }
  } });
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + DAY);
    clock.advance(DAY); await pump(() => runs.length === 1);
    clock.advance(DAY);
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.last_at === START + 2 * DAY);
    const updated = exampleJob("two", "Use the new reviewed instructions."); updated.model = { ...updated.model, reasoning: "high" };
    await app.scheduler.syncJobs([updated]);
    await pump(async () => (await app.scheduler.getJob(updated.id)).schedules[0]?.next_at === START + 3 * DAY);
    releases[0]?.release(); await pump(() => runs.length === 2);
    assert.equal(runs[1]?.job.revision, "one"); assert.equal(runs[1]?.job.model.reasoning, null);
    clock.advance(2 * DAY);
    await pump(async () => (await app.scheduler.getJob(updated.id)).schedules[0]?.last_at === START + 4 * DAY);
    assert.equal(runs.length, 2);
    releases[1]?.release(); await pump(() => runs.length === 3);
    assert.equal(runs[2]?.job.revision, "two"); assert.equal(runs[2]?.job.model.reasoning, "high");
    assert.equal(runs[2]?.scheduled_at, START + 4 * DAY); assert.equal(maximum, 1);
    releases[2]?.release();
  } finally { for (const release of releases) release.release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("source failures and retries do not block job admission or change its request identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-"));
  const clock = new FakeClock(); let reads = 0;
  const app = await openBackground(directory, clock, { refreshSources: async () => { reads += 1; throw new Error("Example source unavailable"); } });
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    await pump(async () => (await app.scheduler.status()).errors.some((error) => error.message === "Example source unavailable"));
    clock.advance(DAY);
    await pump(async () => (await app.receipts())?.jobs.length === 1);
    assert.ok(reads >= 2);
    assert.equal((await app.receipts())?.jobs[0]?.scheduled_at, START + DAY);
    assert.ok((await app.scheduler.status()).errors.some((error) => error.key.type === "builtin" && error.key.name === "sources"));
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a configuration generation fences an old planner before admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-"));
  const clock = new FakeClock(), stale = gate(); let planning = false;
  const app = await openBackground(directory, clock, { plan: async (cadence, after, now, signal) => {
    if (cadence.type === "calendar" && after !== null && !planning) { planning = true; await untilReleased(stale.promise, signal); }
    return planned(cadence, after, now);
  } });
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + DAY);
    clock.advance(DAY); await pump(() => planning);
    await app.scheduler.syncJobs([exampleJob("two", "A newly reviewed definition.")]); stale.release();
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + 2 * DAY);
    assert.equal((await app.receipts())?.jobs.length, 0);
    clock.advance(DAY); await pump(async () => (await app.receipts())?.jobs.length === 1);
    assert.equal((await app.receipts())?.jobs[0]?.job.revision, "two");
  } finally { stale.release(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("reopening preserves sleepers and clock rollback cannot readmit an occurrence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-"));
  const clock = new FakeClock(); let app = await openBackground(directory, clock);
  try {
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + DAY);
    clock.advance(DAY); await pump(async () => (await app.receipts())?.jobs.length === 1 && (await app.scheduler.status()).pending === 0);
    const first = (await app.receipts())?.jobs[0]?.id;
    await app.session.close(BACKGROUND_CONTEXT); app = await openBackground(directory, clock);
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    clock.advance(-DAY / 2); clock.advance(DAY / 2);
    await pump(async () => (await app.scheduler.status()).pending === 0);
    assert.equal((await app.receipts())?.jobs.length, 1); assert.equal((await app.receipts())?.jobs[0]?.id, first);
    clock.advance(DAY); await pump(async () => (await app.receipts())?.jobs.length === 2);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

const boundaries: ("before" | "after")[] = ["before", "after"];
for (const boundary of boundaries) {
  test(`SIGKILL ${boundary} occurrence admission recovers one durable occurrence`, { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-background-kill-"));
    let app: Awaited<ReturnType<typeof openBackground>> | undefined;
    try {
      await killAt(directory, boundary);
      const clock = new FakeClock(START + DAY);
      app = await openBackground(directory, clock);
      await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
      const reopened = app;
      await pump(async () => (await reopened.receipts())?.jobs.length === 1 && (await reopened.scheduler.status()).pending === 0);
      assert.equal((await app.receipts())?.jobs[0]?.scheduled_at, START + DAY);
      assert.equal((await app.scheduler.getJob("example-review")).schedules[0]?.next_at, START + 2 * DAY);
      await app.session.close(BACKGROUND_CONTEXT); app = await openBackground(directory, clock);
      await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
      assert.equal((await app.receipts())?.jobs.length, 1);
    } finally {
      await app?.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
    }
  });
}

test("repeated interrupted restarts expose Pi parking without replacing the durable timer", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-background-parked-"));
  let app: Awaited<ReturnType<typeof openBackground>> | undefined;
  try {
    for (let restart = 0; restart < 5; restart += 1) await killAt(directory, "before");
    app = await openBackground(directory, new FakeClock(START + DAY));
    await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
    const job = await app.scheduler.getJob("example-review");
    assert.match(job.schedules[0]?.error ?? "", /parked after repeated interrupted restarts/);
    assert.equal((await app.receipts())?.jobs.length ?? 0, 0);
    assert.deepEqual(await app.scheduler.syncJobs([exampleJob()]), { added: 0, updated: 0, removed: 0, unchanged: 1 });
    assert.match((await app.scheduler.getJob("example-review")).schedules[0]?.error ?? "", /parked/);
  } finally { await app?.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
