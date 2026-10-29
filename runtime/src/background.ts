import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineEntry, defineTask, ROOT_CONVERSATION_ID, type Harness, type Registry,
  type NextTaskState, type Task, type TaskId as NativeTaskId, type Tx } from "@earendil-works/pi-durable";
import type { BackgroundCadence } from "./generated/BackgroundCadence.js";
import type { BackgroundCheckpoint } from "./generated/BackgroundCheckpoint.js";
import type { BackgroundSettings } from "./generated/BackgroundSettings.js";
import type { BackgroundStatus } from "./generated/BackgroundStatus.js";
import type { BackgroundTaskInput } from "./generated/BackgroundTaskInput.js";
import type { BackgroundTriggerKey } from "./generated/BackgroundTriggerKey.js";
import type { BackgroundWork } from "./generated/BackgroundWork.js";
import type { OccurrencePlan } from "./generated/OccurrencePlan.js";
import type { ScheduledJob } from "./generated/ScheduledJob.js";
import type { ScheduledOccurrence } from "./generated/ScheduledOccurrence.js";
import type { ScheduledJobStatus } from "./generated/ScheduledJobStatus.js";
import type { JobSchedule } from "./generated/JobSchedule.js";
import type { JobSyncReport } from "./generated/JobSyncReport.js";
import type { JobRunReceipt } from "./generated/JobRunReceipt.js";
import type { RuntimeCommand } from "./generated/RuntimeCommand.js";
import { TaskError, TaskStore } from "./tasks.js";
import { scheduledTaskId } from "./scheduled.js";

type Trigger = { key: BackgroundTriggerKey; generation: number; revision: string;
  task: NativeTaskId<null> | null; cursor: number | null; last: number | null; next: number | null; enabled: boolean;
  error: string | null; error_scope: "plan" | "work" | null };
type QueuedWork = { key: BackgroundTriggerKey; work: BackgroundWork };
type JobPreparation = { type: "replay"; receipt: JobRunReceipt } | { type: "admit"; job: ScheduledJob };
type Lane = { id: string; active: NativeTaskId<null> | null; pending: QueuedWork[]; actor_task_id: string | null };
type State = { triggers: Trigger[]; lanes: Lane[]; jobs: ScheduledJob[] };
const State = defineDoc<State>({ kind: "agent.background", scope: "session", version: 1,
  initial: () => ({ triggers: [], lanes: [], jobs: [] }), checkpointWhen: () => true });
type NativeTask = Task<BackgroundTaskInput, BackgroundCheckpoint, null, object>;
/** Native indexed admission evidence; omitted from model context. */
export const JobRunReceiptEntry = defineEntry<JobRunReceipt>("agent.job_run");

export type BackgroundCallbacks = {
  plan(cadence: BackgroundCadence, after: number | null, now: number, signal: AbortSignal): Promise<OccurrencePlan>;
  refreshSources(signal: AbortSignal): Promise<void>;
  collectResources(signal: AbortSignal): Promise<void>;
  jobActor?(job: ScheduledJob): Promise<string | undefined>;
  runJob(occurrence: ScheduledOccurrence, signal: AbortSignal, actorId: string): Promise<void>;
};

function key(value: BackgroundTriggerKey): string {
  return value.type === "builtin" ? JSON.stringify([value.type, value.name])
    : JSON.stringify([value.type, value.job_id, value.schedule_id]);
}
function laneId(value: BackgroundTriggerKey): string {
  return value.type === "builtin" ? key(value) : JSON.stringify([value.type, value.job_id]);
}
function same(left: BackgroundTriggerKey, right: BackgroundTriggerKey): boolean { return key(left) === key(right); }
function terminal(): NextTaskState<BackgroundCheckpoint, null> {
  return { status: "terminal", outcome: { status: "completed", result: null } };
}
function failure(error: unknown): string { return error instanceof Error ? error.message : "Background execution failed"; }
function occurrenceId(value: BackgroundTriggerKey, scheduledAt: number): string {
  // A configuration revision diagnoses a run, but never creates a second occurrence.
  return createHash("sha256").update(JSON.stringify([key(value), scheduledAt])).digest("hex");
}
function revision(job: ScheduledJob, schedule: JobSchedule): string {
  return createHash("sha256").update(JSON.stringify([job.id, job.title, job.prompt,
    job.model.provider, job.model.model_id, job.model.reasoning, job.model.fast, job.timezone, job.cwd,
    schedule.id, schedule.recurrence, schedule.focus, schedule.prompt])).digest("hex");
}
function selectedSchedule(job: ScheduledJob, request: Extract<RuntimeCommand, { type: "run_job" }>): JobSchedule {
  const schedule = request.schedule_id === null
    ? job.schedules.length === 1 ? job.schedules[0] : undefined
    : job.schedules.find((schedule) => schedule.id === request.schedule_id);
  if (schedule === undefined) throw new TaskError(request.schedule_id === null
    ? `Choose a schedule for ${job.id}: ${job.schedules.map((schedule) => schedule.id).join(", ")}`
    : `Unknown schedule for ${job.id}; choose ${job.schedules.map((schedule) => schedule.id).join(", ")}`);
  return schedule;
}

/** Sources and jobs share this single native Pi state machine and its durable timer. */
export class BackgroundScheduler {
  private readonly task: NativeTask;
  constructor(private readonly session: Harness, registry: Registry, private readonly tasks: TaskStore, private readonly callbacks: BackgroundCallbacks) {
    this.task = defineTask<BackgroundTaskInput, BackgroundCheckpoint, null>({
      name: "agent.background", version: 1,
      initial: (input) => input.type === "trigger" ? { phase: "tick", cursor: null } : { phase: "execute", attempt: 0 },
      phases: {
        tick: async (task, runtime, context) => {
          if (task.input.type !== "trigger") throw new Error("Background timer has execution input");
          const input = task.input, cursor = task.state.checkpoint.cursor, observedAt = runtime.now();
          let plan: OccurrencePlan;
          try { plan = await callbacks.plan(input.cadence, cursor, observedAt, runtime.signal); }
          catch (error) {
            await runtime.commit(async (tx) => {
              const state = await tx.doc(State);
              const saved = state.triggers.find((trigger) => same(trigger.key, input.key));
              if (saved === undefined || !saved.enabled || saved.generation !== input.generation) return terminal();
              saved.error = failure(error); saved.error_scope = "plan"; saved.next = runtime.now() + 60_000;
              return { status: "sleeping", until: saved.next, checkpoint: { phase: "tick", cursor } };
            }, context);
            return;
          }
          await runtime.commit(async (tx) => {
            const state = await tx.doc(State);
            const saved = state.triggers.find((trigger) => same(trigger.key, input.key));
            if (saved === undefined || !saved.enabled || saved.generation !== input.generation || saved.cursor !== cursor) return terminal();
            if (saved.error_scope === "plan") { saved.error = null; saved.error_scope = null; }
            const due = plan.due;
            if (due !== null && (saved.cursor === null || due > saved.cursor)) {
              let work: BackgroundWork;
              if (input.key.type === "builtin") work = { type: input.key.name };
              else {
                if (input.job === null) throw new Error("A job timer has no reviewed definition");
                work = { type: "job", occurrence: { id: occurrenceId(input.key, due), job: input.job,
                  schedule_id: input.key.schedule_id, scheduled_at: due } };
              }
              await this.enqueueIn(tx, state, { key: input.key, work });
              saved.last = due;
            }
            const nextCursor = due ?? cursor ?? observedAt;
            saved.cursor = nextCursor; saved.next = plan.next;
            if (plan.next === null) return terminal();
            if (plan.next <= observedAt) throw new Error("Background planner returned a deadline that is already due");
            return { status: "sleeping", until: plan.next, checkpoint: { phase: "tick", cursor: nextCursor } };
          }, context);
        },
        execute: async (task, runtime, context) => {
          if (task.input.type !== "work") throw new Error("Background execution has timer input");
          const input = task.input;
          try {
            switch (input.work.type) {
              case "sources": await callbacks.refreshSources(runtime.signal); break;
              case "resources": await callbacks.collectResources(runtime.signal); break;
              case "job":
              case "manual_job": {
                const occurrence = input.work.occurrence;
                let actorId = await runtime.memo<string>("job_actor_task_id", context);
                if (actorId === undefined) {
                  // Work admitted before actor reuse still owns its original task.
                  const legacy = await this.session.commit(async (tx) =>
                    (await this.tasks.findIn(tx, scheduledTaskId(occurrence.id)))?.id, context);
                  const candidate = legacy ?? await this.actorCandidate(occurrence.job);
                  const created = await this.session.commit(async (tx) =>
                    this.actorIn(tx, await tx.doc(State), occurrence.job, candidate, legacy !== undefined), context);
                  if (created.native !== undefined) this.tasks.rememberConversation(created.native);
                  actorId = await runtime.memo("job_actor_task_id", created.id, context);
                }
                await callbacks.runJob(occurrence, runtime.signal, actorId);
                break;
              }
            }
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            await runtime.commit(async (tx) => {
              const state = await tx.doc(State), saved = state.triggers.find((trigger) => same(trigger.key, input.key));
              if (saved !== undefined) { saved.error = failure(error); saved.error_scope = "work"; }
              // Retain the same admitted work. Its consumer reconciles its stable request identity.
              return { status: "sleeping", until: runtime.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(task.state.checkpoint.attempt, 6)),
                checkpoint: { phase: "execute", attempt: task.state.checkpoint.attempt + 1 } };
            }, context);
            return;
          }
          await runtime.commit(async (tx) => {
            const state = await tx.doc(State), lane = state.lanes.find((item) => item.id === laneId(input.key));
            if (lane?.active === runtime.taskId) {
              lane.active = null;
              const pending = lane.pending.shift();
              if (pending !== undefined) lane.active = await this.createWorkIn(tx, pending);
            }
            const saved = state.triggers.find((trigger) => same(trigger.key, input.key));
            if (saved?.error_scope === "work") { saved.error = null; saved.error_scope = null; }
            return terminal();
          }, context);
        },
      },
      abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
    });
    registry.install({ name: "background", tasks: [this.task] });
  }
  private async createWorkIn(tx: Tx, work: QueuedWork): Promise<NativeTaskId<null>> {
    // Work is conversation-owned, so replacing its timer cannot abort an admitted run.
    return tx.createTask(this.task, { type: "work", ...work }, {
      ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true,
    });
  }
  private async enqueueIn(tx: Tx, state: State, work: QueuedWork): Promise<void> {
    const lane = this.laneIn(state, laneId(work.key));
    if (lane.active === null) { lane.active = await this.createWorkIn(tx, work); return; }
    if (work.work.type === "manual_job") { lane.pending.push(work); return; }
    const previous = lane.pending.findIndex((item) => item.work.type !== "manual_job" && same(item.key, work.key));
    if (previous < 0) lane.pending.push(work); else lane.pending[previous] = work;
  }
  private laneIn(state: State, identity: string): Lane {
    if (!state.lanes.some((item) => item.id === identity)) state.lanes.push({ id: identity, active: null, pending: [], actor_task_id: null });
    // Reacquire the committed document's draft after insertion. Mutating the
    // plain object passed to push would bypass Chord's tracked update.
    const lane = state.lanes.find((item) => item.id === identity);
    if (lane === undefined) throw new Error("Background admission lost its serial lane");
    lane.actor_task_id ??= null;
    return lane;
  }
  private async actorCandidate(job: ScheduledJob): Promise<string> {
    const lane = (await this.session.snapshot(State, BACKGROUND_CONTEXT))?.lanes.find((item) => item.id === JSON.stringify(["job", job.id]));
    return lane?.actor_task_id ?? await this.callbacks.jobActor?.(job) ?? scheduledTaskId("job:" + job.id);
  }
  private async actorIn(tx: Tx, state: State, job: ScheduledJob, candidate: string, legacy = false) {
    const lane = this.laneIn(state, JSON.stringify(["job", job.id]));
    const id = legacy ? candidate : lane.actor_task_id ?? candidate;
    const previous = await this.tasks.findIn(tx, id);
    if (previous !== undefined && !previous.sources.some((source) => source.provider === "scheduled_jobs" &&
        source.account === "local" && source.thread_id === job.id)) throw new TaskError("This task is not owned by the scheduled job");
    if (previous === undefined && id !== scheduledTaskId("job:" + job.id)) throw new TaskError("The scheduled job's owned actor is unavailable; reconcile its existing task");
    const created = await this.tasks.createIn(tx, { id, title: job.title, outcome: job.prompt, model: job.model,
      sources: [{ provider: "scheduled_jobs", account: "local", thread_id: job.id }] });
    lane.actor_task_id ??= created.id;
    return created;
  }
  private async receiptIn(tx: Tx, request: Extract<RuntimeCommand, { type: "run_job" }>): Promise<JobRunReceipt | undefined> {
    const saved = await tx.submissionByRequest(ROOT_CONVERSATION_ID, "job-run:" + request.request_id);
    let receipt: JobRunReceipt | undefined;
    if (saved !== undefined) {
      if (saved.type !== "write" || saved.status !== "done") throw new TaskError("The original job run admission needs reconciliation");
      receipt = (await tx.entry(JobRunReceiptEntry, saved.entry))?.data;
      if (receipt === undefined) throw new TaskError("The original job run receipt is unavailable");
    } else {
      const previous = await this.tasks.findIn(tx, scheduledTaskId("manual:" + request.request_id));
      if (previous === undefined) return undefined;
      receipt = previous.scheduled_run;
    }
    if (receipt === undefined || receipt.request_id !== request.request_id || receipt.job_id !== request.job_id ||
        (request.schedule_id !== null && receipt.schedule_id !== request.schedule_id)) {
      throw new TaskError("This job run request identity already belongs to another selection");
    }
    return { ...receipt };
  }
  async start(settings: BackgroundSettings): Promise<BackgroundStatus> {
    await this.session.root(BACKGROUND_CONTEXT);
    await this.builtins(settings);
    if (settings.jobs !== null) await this.syncJobs(settings.jobs);
    this.session.resume();
    return this.status();
  }
  async runJob(request: Extract<RuntimeCommand, { type: "run_job" }>): Promise<JobRunReceipt> {
    if (request.request_id.trim().length === 0 || request.request_id.length > 128) throw new TaskError("A job run needs a stable request identity");
    const occurrenceId = "manual:" + request.request_id;
    await this.session.root(BACKGROUND_CONTEXT);
    const prepared = await this.session.commit(async (tx): Promise<JobPreparation> => {
      const receipt = await this.receiptIn(tx, request);
      if (receipt !== undefined) return { type: "replay", receipt };
      const job = (await tx.doc(State)).jobs.find((job) => job.id === request.job_id);
      if (job === undefined) throw new TaskError("Unknown scheduled job; list jobs to choose its readable ID");
      selectedSchedule(job, request);
      return { type: "admit", job: { ...job, model: { ...job.model }, schedules: job.schedules.map((schedule) => ({ ...schedule })) } };
    }, BACKGROUND_CONTEXT);
    if (prepared.type === "replay") { this.session.resume(); return prepared.receipt; }
    const candidate = await this.actorCandidate(prepared.job);
    const result = await this.session.commit(async (tx) => {
      // Replay must work after the source file was edited or removed.
      const previous = await this.receiptIn(tx, request);
      if (previous !== undefined) return { receipt: previous, native: undefined };
      const state = await tx.doc(State), job = state.jobs.find((job) => job.id === request.job_id);
      if (job === undefined) throw new TaskError("Unknown scheduled job; list jobs to choose its readable ID");
      const schedule = selectedSchedule(job, request);
      const created = await this.actorIn(tx, state, job, candidate);
      const receipt: JobRunReceipt = { request_id: request.request_id, task_id: created.id, job_id: job.id,
        schedule_id: schedule.id, revision: job.revision, admitted_at: Date.now() };
      // This passive metadata write and queue admission share the native commit.
      const entry = await tx.appendEntry(JobRunReceiptEntry, ROOT_CONVERSATION_ID, { data: receipt });
      await tx.createSubmission({ type: "write", status: "done", conversationId: ROOT_CONVERSATION_ID,
        requestId: "job-run:" + request.request_id, entry: entry.id });
      await this.enqueueIn(tx, state, { key: { type: "job", job_id: job.id, schedule_id: schedule.id },
        work: { type: "manual_job", occurrence: { id: occurrenceId, job, schedule_id: schedule.id, scheduled_at: receipt.admitted_at } } });
      return { receipt, native: created.native };
    }, BACKGROUND_CONTEXT);
    if (result.native !== undefined) this.tasks.rememberConversation(result.native);
    this.session.resume();
    return result.receipt;
  }
  private async replaceIn(tx: Tx, state: State, key: BackgroundTriggerKey, revision: string,
    cadence: BackgroundCadence, job: ScheduledJob | null): Promise<NativeTaskId<null> | null> {
    const previous = state.triggers.find((item) => same(item.key, key));
    if (previous?.enabled && previous.revision === revision) return null;
    const old = previous?.task ?? null;
    const saved: Trigger = { key, generation: (previous?.generation ?? 0) + 1, revision,
      task: null, cursor: null, last: previous?.last ?? null, next: null, enabled: true, error: null, error_scope: null };
    saved.task = await tx.createTask(this.task, { type: "trigger", key, generation: saved.generation, cadence, job }, {
      ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true,
    });
    if (previous === undefined) state.triggers.push(saved); else Object.assign(previous, saved);
    return old;
  }
  private async builtins(settings: BackgroundSettings): Promise<void> {
    const old = await this.session.commit(async (tx) => {
      const state = await tx.doc(State), retired: NativeTaskId<null>[] = [];
      const names: Extract<BackgroundTriggerKey, { type: "builtin" }>["name"][] = ["sources", "resources"];
      for (const name of names) {
        const seconds = name === "sources" ? settings.poll_interval_seconds : 300;
        // The service's refresh callback owns --no-sources semantics.
        const replaced = await this.replaceIn(tx, state, { type: "builtin", name }, JSON.stringify([seconds, settings.sources]),
          { type: "interval", seconds }, null);
        if (replaced !== null) retired.push(replaced);
      }
      return retired;
    }, BACKGROUND_CONTEXT);
    for (const id of old) await this.session.abortTask(id, BACKGROUND_CONTEXT);
  }
  async syncJobs(jobs: ScheduledJob[]): Promise<JobSyncReport> {
    const desired = new Set<string>(), ids = new Set<string>();
    for (const job of jobs) {
      if (ids.has(job.id)) throw new Error("Duplicate scheduled job identity");
      ids.add(job.id);
      for (const schedule of job.schedules) {
        const identity = key({ type: "job", job_id: job.id, schedule_id: schedule.id });
        if (desired.has(identity)) throw new Error("Duplicate scheduled job identity");
        desired.add(identity);
      }
    }
    await this.session.root(BACKGROUND_CONTEXT);
    const result = await this.session.commit(async (tx) => {
      const state = await tx.doc(State), old: NativeTaskId<null>[] = [];
      const before = state.jobs ?? [];
      const report: JobSyncReport = { added: 0, updated: 0, removed: before.filter((job) => !ids.has(job.id)).length, unchanged: 0 };
      for (const job of jobs) {
        const previous = before.find((saved) => saved.id === job.id);
        if (previous === undefined) report.added += 1;
        else if (previous.revision === job.revision) report.unchanged += 1; else report.updated += 1;
      }
      for (const trigger of state.triggers) {
        if (trigger.key.type !== "job" || !trigger.enabled || desired.has(key(trigger.key))) continue;
        trigger.enabled = false; trigger.generation += 1; trigger.next = null;
        if (trigger.task !== null) old.push(trigger.task);
        trigger.task = null;
      }
      for (const job of jobs) for (const schedule of job.schedules) {
        const identity: BackgroundTriggerKey = { type: "job", job_id: job.id, schedule_id: schedule.id };
        const replaced = await this.replaceIn(tx, state, identity, revision(job, schedule),
          { type: "calendar", schedule, timezone: job.timezone }, job);
        if (replaced !== null) old.push(replaced);
      }
      state.jobs = jobs;
      return { old, report };
    }, BACKGROUND_CONTEXT);
    // The generation commit fences old invocations before their asynchronous abort handlers run.
    for (const id of result.old) await this.session.abortTask(id, BACKGROUND_CONTEXT);
    return result.report;
  }
  async status(): Promise<BackgroundStatus> {
    const state = await this.session.snapshot(State, BACKGROUND_CONTEXT);
    const triggers = state?.triggers.filter((trigger) => trigger.enabled) ?? [];
    const errors = await this.errors(state);
    return { jobs: new Set(triggers.flatMap((trigger) => trigger.key.type === "job" ? [trigger.key.job_id] : [])).size,
      triggers: triggers.length, pending: state?.lanes.reduce((count, lane) => count + lane.pending.length + Number(lane.active !== null), 0) ?? 0,
      errors: (state?.triggers ?? []).flatMap((trigger) => {
        const message = errors.get(key(trigger.key));
        return message === undefined ? [] : [{ key: trigger.key, message }];
      }) };
  }
  private async errors(state: State | undefined): Promise<Map<string, string>> {
    const inspection = await this.session.inspect(BACKGROUND_CONTEXT);
    const blocked = new Map<NativeTaskId, string>();
    for (const task of inspection.tasks) if (task.record.kind === "agent.background" && task.state.kind === "blocked") {
      blocked.set(task.record.id, task.state.reason === "restart_limit"
        ? "Background work is parked after repeated interrupted restarts; inspect its native task before retrying"
        : `Background work is blocked by its native task definition (${task.state.reason})`);
    }
    const errors = new Map<string, string>();
    for (const trigger of state?.triggers ?? []) {
      const lane = state?.lanes.find((item) => item.id === laneId(trigger.key));
      const error = trigger.task === null ? undefined : blocked.get(trigger.task);
      const workError = lane?.active === null || lane?.active === undefined ? undefined : blocked.get(lane.active);
      const message = workError ?? error ?? trigger.error;
      if (message !== null && message !== undefined) errors.set(key(trigger.key), message);
    }
    return errors;
  }
  async listJobs(): Promise<ScheduledJobStatus[]> {
    const state = await this.session.snapshot(State, BACKGROUND_CONTEXT);
    const errors = await this.errors(state);
    return (state?.jobs ?? []).map((job) => ({ job: structuredClone(job), schedules: job.schedules.map((schedule) => {
      const trigger = state?.triggers.find((item) => item.key.type === "job" && item.key.job_id === job.id && item.key.schedule_id === schedule.id);
      return { schedule_id: schedule.id, next_at: trigger?.next ?? null, last_at: trigger?.last ?? null,
        error: trigger === undefined ? null : errors.get(key(trigger.key)) ?? null };
    }) }));
  }
  async getJob(id: string): Promise<ScheduledJobStatus> {
    const job = (await this.listJobs()).find((item) => item.job.id === id);
    if (job === undefined) throw new Error("Unknown scheduled job");
    return job;
  }
}
