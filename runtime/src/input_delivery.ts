import type { Session } from "@earendil-works/pi-durable";

/** Publish native placement identities before asynchronous transcript observers. */
export function watchInputPlacements(session: Session,
  emit: (conversation_id: string, input_id: string, entry_id: string) => void): () => void {
  return session.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== "submission") continue;
      const input = change.value;
      if (input.type === "input" && input.status === "placed" && input.requestId !== undefined) {
        emit(input.conversationId.toString(), input.requestId, input.entry.toString());
      }
    }
  });
}
