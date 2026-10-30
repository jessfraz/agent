import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { AssistantEntry, UsageDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { ConversationUsage } from "./generated/ConversationUsage.js";
import type { TelemetryStatus } from "./generated/TelemetryStatus.js";
import type { UsageBucket } from "./generated/UsageBucket.js";

function conversationId(value: unknown): value is ConversationId {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function bucket(name: string, usage: Usage): UsageBucket {
  const cost = usage.cost;
  // Pi's all-zero cost is also its unknown-price sentinel. Never turn it into
  // a claim of free usage, billed spend, or a ChatGPT subscription charge.
  const priced = Object.values(cost).every((amount) => Number.isFinite(amount) && amount >= 0) && cost.total > 0;
  return { name, tokens: { input: usage.input, output: usage.output, cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite, cache_write_1h: usage.cacheWrite1h ?? null, reasoning: usage.reasoning ?? null,
    total: usage.totalTokens }, cost: priced ? { type: "api_estimate", input_usd: cost.input, output_usd: cost.output,
      cache_read_usd: cost.cacheRead, cache_write_usd: cost.cacheWrite, total_usd: cost.total } : { type: "unavailable" } };
}

/** Native ledger totals include this conversation's model/tool/compaction work,
 * never ancestors or child conversations. Reading or replaying entries adds no spend. */
export async function conversationUsage(session: Harness, id: string, telemetry: TelemetryStatus): Promise<ConversationUsage> {
  const native = Number(id);
  if (!conversationId(native) || native.toString() !== id) throw new Error("Choose an existing native conversation");
  const conversation = await session.conversation(native, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("The saved conversation is unavailable");
  const ledger = await session.snapshot(UsageDoc, conversation.id, BACKGROUND_CONTEXT);
  // Duration is recorded by Pi on each model result. This bounded recent sample
  // deliberately makes no lifetime timing/first-token claims about older data.
  const page = await conversation.entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT);
  return { conversation_id: id, recorded: Object.keys(ledger?.models ?? {}).length + Object.keys(ledger?.tools ?? {}).length > 0,
    models: Object.entries(ledger?.models ?? {}).map(([name, usage]) => bucket(name, usage)),
    tools: Object.entries(ledger?.tools ?? {}).map(([name, usage]) => bucket(name, usage)),
    recent_requests: page.items.filter(AssistantEntry.is).flatMap((entry) => (entry.model ?? []).flatMap((message) => message.role === "assistant" ? [{
      entry_id: entry.id.toString(), provider: message.provider, model: message.model, started_at_ms: message.timestamp,
      duration_ms: message.durationMs !== undefined && Number.isFinite(message.durationMs) && message.durationMs >= 0 ? message.durationMs : null,
    }] : [])), recent_entry_limit: 20, telemetry };
}
