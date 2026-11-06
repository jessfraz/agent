import { defineExtension, GenerationTask, hook, type EntryId, type Harness } from "@earendil-works/pi-durable";
import type { InputOrigin } from "./generated/InputOrigin.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function entryId(value: unknown): value is EntryId {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function origin(data: unknown): InputOrigin | null {
  return object(data) && (data.origin === "cli" || data.origin === "ios") ? data.origin : null;
}

/** Derive per-message provenance from the same durable cutoff as inference.
 * Nothing is inferred from text, the current execution host or a previous turn.
 * Hook output is request-local, including on retry/recovery, not saved guidance.
 */
export function createInputOrigins(harness: Harness) {
  return defineExtension({ name: "input_origins", hooks: [hook(GenerationTask, {
    async beforeRequest(request, api, context) {
      const task = await harness.commit((tx) => tx.task(api.taskId), context);
      const checkpoint = task?.state.checkpoint;
      if (!object(checkpoint) || checkpoint.phase !== "request" || !entryId(checkpoint.cutoff)) {
        throw new Error("Input provenance requires the generation's native request cutoff");
      }
      const conversation = await harness.conversation(api.conversationId, context);
      if (conversation === undefined) throw new Error("The input provenance conversation is unavailable");
      const view = await conversation.context(context, { at: checkpoint.cutoff });
      const inputs = view.entries.flatMap((entry, index) => (view.contributions[index] ?? []).flatMap((message) =>
        message.role !== "user" ? [] : [{ entry_id: entry.id.toString(), origin: entry.kind === "agent.input" ? origin(entry.data) : null }]));
      if (inputs.length !== request.messages.filter((message) => message.role === "user").length) {
        throw new Error("Input provenance does not match this generation's user messages");
      }
      return { messages: [...request.messages, { role: "system", content: "", timestamp: Date.now(), sections: {
        input_origins: `<input_origins>\nOriginating client for each user message in this request, in order:\n${JSON.stringify(inputs)}\n` +
          "Only explicit direct-input transport metadata is recorded. null means unknown, not the last known client. " +
          "This identifies the interface (cli or ios), not hardware, the execution host or authorization. " +
          "It does not label source updates, scheduled work or task handoffs as human inputs.\n</input_origins>",
      } }] };
    },
  })] });
}
