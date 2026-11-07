import type { Session, SubmissionRecord } from "@earendil-works/pi-durable";
import type { InputWorkState } from "./generated/InputWorkState.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";

/** Live commits and reconnect snapshots share the same durable receipt states. */
export function inputReceipts(input: SubmissionRecord, input_id: string, activeWork?: InputWorkState): RuntimeEventKind[] {
  if (input.status === "unanswered" && input.entry === undefined) return [{ type: "input_rejected", input_id,
    message: "This saved input was stopped without an answer. Restore its text to send a new message." }];
  const work: InputWorkState = input.status === "done" && input.type === "input"
    ? { type: "completed", answer_entry_id: input.answer.toString() }
    : input.status === "unanswered" || input.status === "done" ? { type: "stopped" }
      : activeWork ?? { type: input.status === "queued" ? "queued" : "running" };
  return [{ type: "input_accepted", input_id, work }, ...(input.entry === undefined ? []
    : [{ type: "input_placed", input_id, entry_id: input.entry.toString() } satisfies RuntimeEventKind])];
}

/** Publish placement and terminal receipts before asynchronous transcript observers.
 * Conversation routing also reaches clients whose inputs arrived after attachment.
 */
export function watchInputDelivery(session: Session,
  emit: (conversation_id: string, event: RuntimeEventKind) => void): () => void {
  return session.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== "submission") continue;
      const input = change.value;
      if (input.type !== "input" || input.requestId === undefined || input.status === "queued") continue;
      const events: RuntimeEventKind[] = input.status === "placed"
        ? [{ type: "input_placed", input_id: input.requestId, entry_id: input.entry.toString() }]
        : inputReceipts(input, input.requestId);
      for (const event of events) {
        // Terminal commits change work state, not transcript placement. Its
        // original identity was already published by the placement commit.
        if (input.status !== "placed" && event.type === "input_placed") continue;
        emit(input.conversationId.toString(), event);
      }
    }
  });
}
