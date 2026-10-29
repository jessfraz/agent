import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { ScheduledOccurrence } from "./generated/ScheduledOccurrence.js";
import type { ScheduledJob } from "./generated/ScheduledJob.js";
import { CoordinatorEnvironment } from "./environment.js";
import { SourceJournal } from "./sources.js";
import { TaskError, TaskStore, type HostCall } from "./tasks.js";
import { Executions } from "./tools.js";

/** A stable UUID keeps the ordinary task API authoritative across replay. */
export function scheduledTaskId(occurrence: string): string {
  const bytes = createHash("sha256").update(occurrence).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function occurrencePrompt(occurrence: ScheduledOccurrence): string {
  const schedule = occurrence.job.schedules.find((schedule) => schedule.id === occurrence.schedule_id);
  if (schedule === undefined) throw new TaskError("The admitted job schedule is unavailable");
  return [occurrence.job.prompt,
    ...(schedule.prompt === null ? [] : [`This occurrence's focus${schedule.focus === null ? "" : ` (${schedule.focus})`}:\n${schedule.prompt}`]),
    `Scheduled occurrence: ${occurrence.id}. Continue related unfinished tasks and retain their decisions.`,
  ].join("\n\n");
}

/** Adopt only a job-owned chat; a mutable, nonunique title is not ownership. */
export async function openJobActor(job: ScheduledJob, tasks: TaskStore, call: HostCall): Promise<string | undefined> {
  const candidates = (await tasks.list()).filter((task) => task.sources.some((source) =>
    source.provider === "scheduled_jobs" && source.account === "local" && source.thread_id === job.id))
    .sort((left, right) => right.updated_at - left.updated_at || left.id.localeCompare(right.id));
  for (const task of candidates) {
    if (!("binding" in task.worker)) {
      if (task.worker.state !== "unassigned" || task.pending.length > 0) return task.id;
      continue;
    }
    const result = await call({ type: "on_node", host_id: task.worker.binding.host_id,
      command: { type: "inspect_worker", binding: task.worker.binding } });
    if (result.type !== "worker_presence") throw new TaskError("The scheduled job's existing Rex session could not be inspected; no duplicate was opened");
    if (result.presence.state !== "missing_session") return task.id;
  }
  return undefined;
}

async function requireReconciledTask(session: Harness, tasks: TaskStore, sources: SourceJournal, id: string, requestId: string): Promise<void> {
  const conversation = await tasks.conversation((await tasks.get(id)).conversation_id);
  if (!await session.commit(async (tx) => await tasks.canSettleScheduledIn(tx, id, conversation.id) &&
      (await tasks.canReleaseIn(tx, id) || await sources.reconcilesIn(tx, id, conversation.id, requestId)), BACKGROUND_CONTEXT)) {
    throw new TaskError("The scheduled turn stopped without an answer; resolve its task or explicitly reconcile its exact input in a successful recovery turn before this occurrence can settle");
  }
}

/** Dispatch through the existing task lifecycle, then await its exact Pi input. */
export async function runScheduled(occurrence: ScheduledOccurrence, signal: AbortSignal,
  services: { session: Harness; tasks: TaskStore; sources: SourceJournal; environment: CoordinatorEnvironment; executions: Executions; call: HostCall },
  id = scheduledTaskId(occurrence.id)): Promise<void> {
  const { session, tasks, sources, environment, executions, call } = services;
  const task = await tasks.create({ id, title: occurrence.job.title,
    outcome: occurrence.job.prompt, model: occurrence.job.model,
    sources: [{ provider: "scheduled_jobs", account: "local", thread_id: occurrence.job.id }] });
  const conversation = await tasks.conversation(task.conversation_id);
  let revision = 0;
  let wake: (() => void) | undefined;
  const stop = session.subscribeCommits(() => { revision += 1; wake?.(); });
  const aborted = () => wake?.(); signal.addEventListener("abort", aborted);
  try {
    let submission = await session.commit((tx) => tx.submissionByRequest(conversation.id, occurrence.id), BACKGROUND_CONTEXT);
    if (submission?.status === "done") return;
    if (submission?.status === "unanswered") { await requireReconciledTask(session, tasks, sources, id, occurrence.id); return; }
    const previousOutcome = (await sources.events({ provider: "task_outcomes", thread_id: id, limit: 1 }))[0]?.key;
    // A restored native input can progress only after its real worker binds.
    // Allocation confirmation and the worker's run_task connection are separate.
    executions.expect(conversation.id.toString());
    if (submission === undefined) {
      if (!task.pending.some((input) => input.id === occurrence.id)) {
        await tasks.enqueueScheduled(id, occurrencePrompt(occurrence), occurrence);
      }
    }
    if (!tasks.isRunning(id)) {
      const hosts = await environment.hosts(occurrence.job.cwd, null, []);
      const host = task.worker.state === "bound" ? await tasks.workerHost(id) : await environment.defaultHost(hosts);
      if (host === null) throw new TaskError("The scheduled job's coordinator execution host is offline; its task is retained");
      // Jobs run relative to their owning Git repository, independent of the
      // directory from which the daemon was started.
      await tasks.dispatch(id, { ...host, cwd: occurrence.job.cwd }, call);
    }
    for (;;) {
      if (signal.aborted) throw new TaskError("Scheduled work stopped with the coordinator; its admission is retained");
      const observed = revision;
      submission = await session.commit((tx) => tx.submissionByRequest(conversation.id, occurrence.id), BACKGROUND_CONTEXT);
      if (submission !== undefined) {
        const native = await session.submission(submission.id, BACKGROUND_CONTEXT);
        if (native === undefined) throw new TaskError("The scheduled job's admitted Pi input is unavailable");
        const result = await native.wait(withAbortSignal(signal, BACKGROUND_CONTEXT));
        if (result.type === "input" && result.status === "unanswered") { await requireReconciledTask(session, tasks, sources, id, occurrence.id); return; }
        if (result.type !== "input" || result.status !== "done") throw new TaskError("The scheduled turn did not complete; inspect its existing task");
        return;
      }
      const outcomes = await sources.events({ provider: "task_outcomes", thread_id: id, limit: 1 });
      const latest = outcomes[0], failure = latest?.outcome;
      if (latest?.key !== previousOutcome && failure?.state.state === "failed") throw new TaskError(failure.state.reason);
      await new Promise<void>((resolve) => { wake = resolve; if (revision !== observed || signal.aborted) resolve(); });
      wake = undefined;
    }
  } finally { stop(); signal.removeEventListener("abort", aborted); }
}
