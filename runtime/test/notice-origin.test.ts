import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { BackgroundScheduler } from "../src/background.js";
import { watchMainNotices } from "../src/main_observation.js";
import { runScheduled } from "../src/scheduled.js";
import { history, UserNoticeEntry } from "../src/transcript.js";
import { validEvent } from "../src/protocol.js";
import type { HistoryMessage } from "../src/generated/HistoryMessage.js";
import type { TaskRecord } from "../src/generated/TaskRecord.js";
import { DAY, exampleJob, FakeClock } from "./fixtures/background-runtime.js";
import { openScheduled } from "./fixtures/scheduled-runtime.js";

function scheduler(app: Awaited<ReturnType<typeof openScheduled>>, completed: string[]) {
  return new BackgroundScheduler(app.session, app.registry, app.tasks, {
    async plan(_cadence, _after, now) { return { due: null, next: now + DAY }; },
    async refreshSources() {}, async triageSources() {}, async collectResources() {}, async indexHistory() {},
    async runJob(occurrence, signal, actor) {
      const scheduled = runScheduled(occurrence, signal, app, actor);
      while ((await app.tasks.get(actor)).worker.state !== "bound") await new Promise((resolve) => setTimeout(resolve, 2));
      await Promise.all([scheduled, app.worker(actor)]); completed.push(occurrence.id);
    },
  });
}
async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await condition()) { assert.ok(Date.now() < deadline, "The admitted producer did not finish"); await new Promise((resolve) => setTimeout(resolve, 2)); }
}
function notice(text: string) { return fauxAssistantMessage(fauxToolCall("notify_user", { text }), { stopReason: "toolUse" }); }
function origin(row: HistoryMessage | undefined, job: { id: string; title: string }) {
  assert.ok(row); assert.deepEqual(row, { ...row, notice_origin: { job_id: job.id, title: job.title } });
}
async function continued(app: Awaited<ReturnType<typeof openScheduled>>, task: TaskRecord, id: string, text: string): Promise<void> {
  app.faux.setResponses([notice(text), fauxAssistantMessage("")]);
  await app.tasks.enqueue(task.id, "Continue this saved workflow.", id); await app.worker(task.id);
}

test("actual concurrent scheduler publications retain run titles live and after rename, deletion and reopen", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notice-origins-")), clock = new FakeClock();
  let app = await openScheduled(directory, "original", clock), stop = () => {};
  try {
    const completed: string[] = [], background = scheduler(app, completed);
    const packages = { ...exampleJob(), id: "package-tracking", title: "Package tracking", prompt: "PACKAGE_JOB_FIXTURE" };
    const brief = { ...exampleJob(), id: "morning-brief", title: "Morning brief", prompt: "BRIEF_JOB_FIXTURE" };
    await background.syncJobs([packages, brief]);
    const live: HistoryMessage[] = [], root = await app.session.root(BACKGROUND_CONTEXT);
    stop = await watchMainNotices(app.session, root, (event) => {
      assert.ok(validEvent({ version: 1, id: 1, event })); if (event.type === "message") live.push(event.message);
    });
    let entered = 0, release = () => {}; const both = new Promise<void>((resolve) => { release = resolve; });
    const respond: FauxResponseFactory = async (context) => {
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("");
      entered += 1; if (entered === 2) release(); await both;
      // Deliberately misleading body labels cannot choose the originating job.
      return notice(JSON.stringify(context.messages).includes("PACKAGE_JOB_FIXTURE") ? "Morning brief: the parcel needs a decision." : "Package tracking: a briefing decision is needed.");
    };
    app.faux.setResponses([respond, respond, respond, respond]);
    const [packageRun] = await Promise.all([
      background.runJob({ type: "run_job", job_id: packages.id, schedule_id: null, request_id: "packages" }),
      background.runJob({ type: "run_job", job_id: brief.id, schedule_id: null, request_id: "brief" }),
    ]);
    await eventually(() => completed.length === 2); assert.equal(entered, 2); assert.equal(live.length, 2);
    origin(live.find((row) => row.text.includes("parcel")), packages); origin(live.find((row) => row.text.includes("briefing")), brief);
    const renamed = { ...packages, title: "Renamed tracking", revision: "renamed" };
    await background.syncJobs([renamed, brief]);
    const task = await app.tasks.get(packageRun.task_id);
    await app.tasks.update(task.id, (saved) => { saved.title = "An unrelated mutable task title"; });
    await continued(app, task, "continue-before-next-run", "A continuation retains its admitted workflow origin.");
    origin(live.at(-1), packages);
    app.faux.setResponses([notice("The renamed job's new run."), fauxAssistantMessage("")]);
    await background.runJob({ type: "run_job", job_id: packages.id, schedule_id: null, request_id: "renamed" });
    await eventually(() => completed.length === 3); origin(live.at(-1), renamed);
    await background.syncJobs([brief]);
    await continued(app, task, "after-delete", "A saved continuation survives source deletion."); origin(live.at(-1), renamed);
    const count = live.length, calls = app.faux.state.callCount;
    await background.runJob({ type: "run_job", job_id: packages.id, schedule_id: null, request_id: "packages" });
    assert.equal(live.length, count); assert.equal(app.faux.state.callCount, calls, "Replay must not generate an extra publication");
    const durable = (await history(root, null, app.session)).flatMap((event) => event.messages).filter((row) => row.role === "notice");
    assert.deepEqual(durable, live, "Live and historical native rows carry the same captured snapshot");
    stop(); stop = () => {}; await app.session.close(BACKGROUND_CONTEXT);
    app = await openScheduled(directory, "original", clock); scheduler(app, []);
    const reopened = (await history(await app.session.root(BACKGROUND_CONTEXT), null, app.session)).flatMap((event) => event.messages).filter((row) => row.role === "notice");
    assert.deepEqual(reopened, durable, "Historical rows must not look up renamed or deleted job/task titles");
    origin(reopened.find((row) => row.text.includes("parcel")), packages);
  } finally { stop(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a scheduled child inherits its trusted lineage through deletion and its own continuation", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notice-child-")); let app = await openScheduled(directory, "original", new FakeClock());
  try {
    const completed: string[] = [], background = scheduler(app, completed), job = { ...exampleJob(), title: "Package tracking" };
    await background.syncJobs([job]);
    app.faux.setResponses([fauxAssistantMessage(fauxToolCall("spawn_agent", { title: "Unrelated child title", outcome: "Check the admitted source.", input: "Check the parcel." }), { stopReason: "toolUse" }), fauxAssistantMessage("")]);
    const run = await background.runJob({ type: "run_job", job_id: job.id, schedule_id: null, request_id: "child-job" }); await eventually(() => completed.length === 1);
    const task = await app.tasks.get(run.task_id), child = task.agents[0]; assert.ok(child); assert.equal(child.worker.state, "bound");
    await background.syncJobs([]); await app.tasks.update(task.id, (saved) => { saved.title = "Wrong renamed parent title"; });
    app.faux.setResponses([notice("The child needs a concrete decision."), fauxAssistantMessage(fauxToolCall("report_result", { summary: "Checked the parcel with evidence." }), { stopReason: "toolUse" }), fauxAssistantMessage("")]);
    await app.worker(task.id, new AbortController(), app.call, false, child.id);
    const root = await app.session.root(BACKGROUND_CONTEXT), rows = (await history(root, null, app.session)).flatMap((event) => event.messages).filter((row) => row.role === "notice");
    assert.equal(rows.length, 1); origin(rows[0], job);
    await app.session.close(BACKGROUND_CONTEXT); app = await openScheduled(directory, "original", new FakeClock()); scheduler(app, []);
    const saved = (await history(await app.session.root(BACKGROUND_CONTEXT), null, app.session)).flatMap((event) => event.messages).filter((row) => row.role === "notice");
    assert.deepEqual(saved, rows);
    await app.tasks.continueAgent(task.id, child.id, "Recheck this same workflow.", "child-followup", app.call);
    app.faux.setResponses([notice("The same child has a second necessary decision."), fauxAssistantMessage(fauxToolCall("report_result", { summary: "Rechecked the same evidence." }), { stopReason: "toolUse" }), fauxAssistantMessage("")]);
    await app.worker(task.id, new AbortController(), app.call, false, child.id);
    const continuedRows = (await history(await app.session.root(BACKGROUND_CONTEXT), null, app.session)).flatMap((event) => event.messages).filter((row) => row.role === "notice");
    assert.equal(continuedRows.length, 2); origin(continuedRows[1], job);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("main, generic and legacy notices never guess a job from titles, source links or body text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notice-generic-")), app = await openScheduled(directory);
  try {
    const task = await app.tasks.create({ title: "Morning brief", outcome: "An ordinary task", sources: [{ provider: "scheduled_jobs", account: "local", thread_id: "morning-brief" }] });
    const host = await app.environment.defaultHost(await app.environment.hosts("/workspace/example", null, [])); assert.ok(host);
    await app.tasks.enqueue(task.id, "Package tracking: a claimed job name is not transport metadata.", "generic"); await app.tasks.dispatch(task.id, host, app.call);
    app.faux.setResponses([notice("Morning brief: actionable generic work."), fauxAssistantMessage("")]); await app.worker(task.id);
    const root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.sourceTools.main] }, BACKGROUND_CONTEXT);
    const unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], call: app.call });
    try { app.faux.setResponses([notice("Package tracking: a direct main-chat update."), fauxAssistantMessage("")]);
      await (await root.submit({ type: "input", content: "A direct request with no scheduled producer." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    } finally { unbind(); }
    await root.submit({ type: "write", entry: { kind: UserNoticeEntry.kind, data: { task_id: task.id, source_conversation_id: task.conversation_id, source_entry_id: "1", text: "Legacy generic notice" } } }, BACKGROUND_CONTEXT);
    for (const metadata of [{ job_id: "", title: "Package tracking" }, { job_id: "package-tracking", title: "  " }]) {
      await root.submit({ type: "write", entry: { kind: UserNoticeEntry.kind, data: { task_id: null, source_conversation_id: "legacy", source_entry_id: "1", text: "Unreliable legacy metadata", notice_origin: metadata } } }, BACKGROUND_CONTEXT);
    }
    const rows = (await history(root, null, app.session)).flatMap((event) => event.messages).filter((row) => row.role === "notice");
    assert.equal(rows.length, 5); for (const row of rows) assert.equal("notice_origin" in row, false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
