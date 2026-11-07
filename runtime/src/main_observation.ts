import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, ROOT_CONVERSATION_ID, type Conversation, type Harness, type Session, type TaskId, type TaskInspection } from "@earendil-works/pi-durable";
import type { InputWorkState } from "./generated/InputWorkState.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import { isUserNotice, MainResponses, visibleTranscript } from "./transcript.js";
import { mainResponse } from "./main_response.js";
import { observeTranscriptVisibility } from "./transcript_visibility.js";
import { inputReceipts } from "./input_delivery.js";

type BlockedMainWork = Extract<InputWorkState, { type: "blocked" }> & { recovery: "message" | "inspect_outcome" | "update_runtime" };
export type MainWorkState = { type: "idle" } | { type: "running" } | BlockedMainWork;

function isRootGeneration({ record }: TaskInspection, root: Conversation, run: TaskId | undefined): boolean {
  return record.id === run && record.conversationId === root.id && record.kind === "pi.generation" && record.owner === undefined && !record.background;
}

/** Inspect the active run and its owned work without enabling scheduling. */
export async function inspectMainWork(session: Harness, root: Conversation): Promise<MainWorkState> {
  const run = (await session.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT))?.run;
  if (run === undefined) return { type: "idle" };
  const tasks = (await session.inspect(BACKGROUND_CONTEXT)).tasks;
  const byId = new Map<TaskId, TaskInspection>(tasks.map((task) => [task.record.id, task]));
  const blocked = tasks.find((task) => {
    if (task.state.kind !== "blocked") return false;
    let owner: TaskInspection | undefined = task;
    while (owner !== undefined && !owner.record.background) {
      if (owner.record.id === run.taskId) return true;
      owner = owner.record.owner === undefined ? undefined : byId.get(owner.record.owner);
    }
    return false;
  });
  if (blocked?.state.kind !== "blocked") return { type: "running" };
  const recovery = blocked.state.reason !== "restart_limit" ? "update_runtime"
    : isRootGeneration(blocked, root, run.taskId) ? "message" : "inspect_outcome";
  return { type: "blocked", reason: blocked.state.reason, recovery };
}

/** Admission retries and reconnect must agree about terminal Pi submissions. */
export async function reconcileMainInput(root: Conversation, input_id: string, session: Harness, snapshot?: MainWorkState): Promise<RuntimeEventKind[] | undefined> {
  const saved = await root.commit((tx) => tx.submissionByRequest(root.id, input_id), BACKGROUND_CONTEXT);
  if (saved === undefined) return undefined;
  let work: InputWorkState | undefined;
  if (saved.status === "queued" || saved.status === "placed") {
    const current = snapshot ?? await inspectMainWork(session, root);
    work = current.type === "blocked" ? { type: "blocked", reason: current.reason }
      : { type: saved.status === "queued" ? "queued" : "running" };
  }
  const events = inputReceipts(saved, input_id, work);
  if (root.id === ROOT_CONVERSATION_ID && saved.type === "input" && saved.status === "done" && saved.entry !== undefined) {
    const response = await mainResponse(session, root, saved.entry, saved.answer);
    if (response.text.trim() && await session.snapshot(MainResponses, root.id, saved.answer.toString(), BACKGROUND_CONTEXT) !== undefined) {
      events.push({ type: "answer", conversation_id: root.id.toString(), ...response });
    }
  }
  return events;
}

/** Only an explicit continuation, with its execution owner ready, grants another
 * generation attempt. Parked tool effects and background tasks keep their budgets.
 */
export async function recoverMainGeneration(session: Harness, root: Conversation): Promise<void> {
  const run = (await session.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT))?.run;
  for (const task of (await session.inspect(BACKGROUND_CONTEXT)).tasks) {
    if (isRootGeneration(task, root, run?.taskId) && task.state.kind === "blocked" && task.state.reason === "restart_limit") {
      await session.retryTask(task.record.id, BACKGROUND_CONTEXT);
    }
  }
}

/** Main notices can be published by a worker while the root has no execution.
 * Observe the durable entry, not its anonymous execution-local notification.
 * This never claims execution or forwards effects, tool arguments or references.
 */
export async function watchMainNotices(session: Session, root: Conversation, emit: (event: RuntimeEventKind) => void): Promise<() => void> {
  const observation = await observeTranscriptVisibility(session, root.id, (entry, visibility) => {
    if (!isUserNotice(entry) && entry.kind !== "agent.notice") return;
    for (const message of visibleTranscript(entry, visibility)) if (message.role === "notice") emit({ type: "message", message });
  });
  return observation.close;
}
