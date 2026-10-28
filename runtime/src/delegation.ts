import { defineDocFamily, defineEntry, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { DelegationDecision } from "./generated/DelegationDecision.js";

export const DelegationDecisionEntry = defineEntry<DelegationDecision>("agent.delegation");
const Receipts = defineDocFamily<{ entry_id: number | null }, null>({
  kind: "agent.delegation.receipts", scope: "session", family: true, version: 1,
  initial: () => ({ entry_id: null }), checkpointWhen: () => true,
});

/** Commit the private decision once beside its native tool-call provenance. */
export async function recordDelegation(tx: Tx, conversationId: ConversationId, decision: DelegationDecision): Promise<void> {
  if (conversationId.toString() !== decision.actor_conversation_id) throw new Error("Delegation decision belongs to another conversation");
  const receipt = await tx.doc(Receipts, JSON.stringify([decision.actor_conversation_id, decision.tool_call_id]), null);
  if (receipt.entry_id !== null) return;
  const entry = await tx.appendEntry(DelegationDecisionEntry, conversationId, { data: decision });
  receipt.entry_id = entry.id;
}
