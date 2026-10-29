import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
    assert.equal((await app.scheduler.status()).triggers, 2);
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
