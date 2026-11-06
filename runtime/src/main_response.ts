import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { AssistantEntry, defineDocFamily, defineExtension, defineTool, GenerationTask, hook, LiveDoc, ROOT_CONVERSATION_ID, type Conversation, type Cursor, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { MainResponses, UserNoticeEntry, visibleTranscript } from "./transcript.js";
import { readTranscriptVisibility } from "./transcript_visibility.js";

/** Only the interactive main owner installs this policy, never background actors. */
export const MAIN_RESPONSE_INSTRUCTIONS = `Direct user replies in this main chat:
Answer direct user questions and requests, including follow-ups or steering,
truthfully and visibly. Respect explicit requests to work quietly; do not require
routine acknowledgments or narrate tool use.
When explicitly asked not to reply, finish the requested work and call
finish_without_reply by itself instead of returning an empty final message.
An existing visible reply to that input already counts; do not add a duplicate
acknowledgment or canned status. Do not claim work started or completed without
evidence. Quietness rules for routine receipts and unsolicited background,
scheduled or source work do not suppress replies to direct user messages.`;

type MainResponse = { text: string; entry_id: string };

// A native generation owns this decision. Older blank answers have no recorded
// policy outcome: their intent is unknown, so never invent a repair for them.
const MainReplyOutcomes = defineDocFamily<{ mode: "blank" | "silent" }, "blank" | "silent">({
  kind: "agent.main_reply_outcome", scope: "conversation", family: true, version: 1,
  history: "latest", fork: "initial", initial: (mode) => ({ mode }), checkpointWhen: () => true,
});

/** Keep the model's explicit quiet choice in native durable ownership, without
 * parsing user text, exporting reasoning or requesting another inference. */
export function createMainResponsePolicy(session: Harness) {
  return defineExtension({ name: "main-response-policy", hooks: [hook(GenerationTask, {
    async onYield(message, api, context) {
      if (api.conversationId !== ROOT_CONVERSATION_ID || message.content.some((part) => part.type === "text" && part.text.trim())) return undefined;
      await session.commit((tx) => tx.doc(MainReplyOutcomes, api.conversationId, api.taskId.toString(), "blank"), context);
      return undefined;
    },
  })], tools: [defineTool({
    name: "finish_without_reply", replay: "safe", parameters: Type.Object({}),
    description: "Finish this main-chat turn without a written reply ONLY when the user explicitly requested no chat reply or completion receipt. Finish the requested work first, then call this tool alone. Routine background quietness is not permission to suppress a direct question.",
    async execute(_args, api, context) {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("Only the main-chat owner can finish without a reply");
      await api.commit(async (tx) => {
        const call = await tx.task(api.taskId);
        const generation = call?.owner === undefined ? undefined : await tx.task(call.owner);
        const live = await tx.doc(LiveDoc, api.conversationId);
        // Nested, parallel or stale calls cannot terminate unrelated work. A
        // later queued steer belongs to the next native run, not this choice.
        if (generation?.kind !== GenerationTask.definition.name || generation.owner !== undefined ||
            live.run?.taskId !== generation.id || live.tools?.length !== 1 || live.tools[0]?.taskId !== api.taskId) {
          throw new Error("Finish without reply must be the main owner's sole final tool");
        }
        const outcome = await tx.doc(MainReplyOutcomes, api.conversationId, generation.id.toString(), "silent");
        outcome.mode = "silent";
      }, context);
      return { output: [], control: { terminate: true } };
    },
  })] });
}

/** A silent completed model turn must not silently consume a direct input.
 * Keep this on the main owner, after native settlement: never admit another
 * inference, alter the inbox, or turn scheduled/worker outcomes into receipts.
 */
export async function mainResponse(session: Harness, root: Conversation, input: EntryId, answer: EntryId): Promise<MainResponse> {
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, answer), BACKGROUND_CONTEXT);
  const text = entry?.model?.flatMap((message) => message.role !== "assistant" ? []
    : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n") ?? "";
  const response = { text, entry_id: answer.toString() };
  if (text.trim() || root.id !== ROOT_CONVERSATION_ID || entry?.byTaskId === undefined) return response;
  const outcome = await session.snapshot(MainReplyOutcomes, root.id, entry.byTaskId.toString(), BACKGROUND_CONTEXT);
  if (outcome?.mode !== "blank") return response;
  const visibility = await readTranscriptVisibility(session, root.id);
  let cursor: Cursor | undefined;
  do {
    const page = await root.entries({ minEntryId: input, maxEntryId: answer, order: "descending" }, 32, cursor, BACKGROUND_CONTEXT);
    for (const candidate of page.items) {
      // An unrelated worker notice does not answer this main-chat input.
      const ownedNotice = UserNoticeEntry.is(candidate) && candidate.data.source_conversation_id === root.id.toString();
      if (visibleTranscript(candidate, visibility).some((message) => message.text.trim() &&
        (["assistant", "commentary", "final"].includes(message.role) || ownedNotice && message.role === "notice"))) return response;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  // A diagnostic, not an invented model acknowledgment or claim of progress.
  // Steered inputs sharing one native answer share this durable reply too.
  const diagnostic = "No written response was produced for this request; completion is not confirmed.";
  // Native terminal settlement precedes this owner-side correction. A keyed
  // document makes crash repair idempotent without inventing a later answer ID.
  const saved = await root.commit(async (tx) => (await tx.doc(MainResponses, root.id, answer.toString(), diagnostic)).text, BACKGROUND_CONTEXT);
  return { text: saved, entry_id: answer.toString() };
}
