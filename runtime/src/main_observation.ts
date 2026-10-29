import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Session } from "@earendil-works/pi-durable";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import { transcript } from "./transcript.js";

/** Admission retries and reconnect must agree about terminal Pi submissions. */
export async function reconcileMainInput(root: Conversation, input_id: string): Promise<RuntimeEventKind[] | undefined> {
  const saved = await root.commit((tx) => tx.submissionByRequest(root.id, input_id), BACKGROUND_CONTEXT);
  if (saved === undefined) return undefined;
  if (saved.status === "unanswered" && saved.entry === undefined) return [{ type: "input_rejected", input_id,
    message: "This saved input was stopped without an answer. Restore its text to send a new message." }];
  return [{ type: "input_accepted", input_id }, ...(saved.entry === undefined ? []
    : [{ type: "input_placed", input_id, entry_id: saved.entry.toString() } satisfies RuntimeEventKind])];
}

/** Main notices can be published by a worker while the root has no execution.
 * Observe the durable entry, not its anonymous execution-local notification.
 * This never claims execution or forwards effects, tool arguments or references.
 */
export function watchMainNotices(session: Session, root: Conversation, emit: (event: RuntimeEventKind) => void): () => void {
  return session.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== "entry" || change.value.conversationId !== root.id || change.value.kind !== "agent.notice") continue;
      for (const message of transcript(change.value)) if (message.role === "notice") emit({ type: "message", message });
    }
  });
}
