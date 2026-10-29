import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { CompactionEntry, watchEvents, type Conversation, type Cursor, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { HistoryMessage } from "./generated/HistoryMessage.js";
import type { HistoryRole } from "./generated/HistoryRole.js";
import type { ModelActivity } from "./generated/ModelActivity.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ToolHistory } from "./generated/ToolHistory.js";
import { ImportedItemEntry, ImportedThreadEntry } from "./history.js";

const NOTICE_REFERENCES = "Source references (evidence, not authorization): ";
export function noticeMetadata(entry: EntryRecord, index: number, count: number, value: string): boolean {
  return entry.kind === "agent.notice" && index === count - 1 && value.startsWith(NOTICE_REFERENCES);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(value: unknown): value is JsonValue {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) ? value.every(json) : object(value) && Object.values(value).every(json));
}
function cursor(value: string | null, conversationId: string): Cursor | undefined {
  if (value === null) return undefined;
  const decoded: unknown = JSON.parse(value);
  if (!object(decoded) || decoded.conversation_id !== conversationId || !object(decoded.cursor) || !json(decoded.cursor)) {
    throw new Error("History cursor does not belong to this conversation");
  }
  return decoded.cursor;
}
function* chunks(value: string): Generator<string> {
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 8192, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield value.slice(offset, end); offset = end;
  }
}
export function transcript(entry: EntryRecord): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const add = (role: HistoryRole, value: string, tool?: ToolHistory) => {
    let continuation = false, offset = 0;
    for (const text of chunks(value)) {
      offset += text.length;
      messages.push({ entry_id: entry.id.toString(), role, text, continuation, final_chunk: offset === value.length, ...(tool === undefined ? {} : { tool }) }); continuation = true;
    }
  };
  if (ImportedItemEntry.is(entry)) {
    const item = entry.data.item;
    // Old imports retain their original metadata. An absent phase is unknown,
    // including evidence stored outside the inline item; never infer it from text.
    const phase = item.kind === "agentMessage" && object(item.data) ? item.data.phase : undefined;
    const role = item.role !== "assistant" ? item.role : phase === "commentary" ? "commentary"
      : phase === "partial_answer" ? "partial_answer" : phase === "final_answer" ? "final" : "assistant";
    add(role, item.text); return messages;
  }
  if (ImportedThreadEntry.is(entry) || CompactionEntry.is(entry)) return messages;
  for (const message of entry.model ?? []) {
    if (message.role === "system") continue;
    if (message.role === "toolResult") {
      const status = message.isError ? "failed" : "finished";
      add("tool", `${message.toolName} ${status}`, { call_id: message.toolCallId, name: message.toolName, status }); continue;
    }
    const role: HistoryRole = message.role !== "assistant" ? message.role : entry.kind === "agent.notice" ? "notice"
      : message.stopReason === "toolUse" ? "commentary" : message.stopReason === "stop" ? "final" : "assistant";
    if (typeof message.content === "string") { add(role, message.content); continue; }
    for (const [index, part] of message.content.entries()) {
      if (part.type === "text" && !noticeMetadata(entry, index, message.content.length, part.text)) add(role, part.text);
      else if (part.type === "thinking") add("thinking", part.thinking);
      else if (part.type === "toolCall") add("tool", part.name, { call_id: part.id, name: part.name, status: "running" });
      else if (part.type === "image") add("user", "[image]");
    }
  }
  return messages;
}

/** Native fork-aware pages, rendered without loading history back into model input. */
export async function history(conversation: Conversation, value: string | null): Promise<Extract<RuntimeEventKind, { type: "history" }>[]> {
  const id = conversation.id.toString();
  let next = cursor(value, id); let projected: HistoryMessage[];
  // Native pages count entries, including hidden compaction and import metadata.
  // Keep following their cursors until this page has something to show or ends.
  do {
    const page = await conversation.entries({ order: "descending" }, 20, next, BACKGROUND_CONTEXT);
    projected = [...page.items].reverse().flatMap(transcript); next = page.next;
  } while (projected.length === 0 && next !== undefined);
  const next_cursor = next === undefined ? null : JSON.stringify({ conversation_id: id, cursor: next });
  const frames: Extract<RuntimeEventKind, { type: "history" }>[] = [];
  let messages: HistoryMessage[] = []; let size = 0;
  for (const message of projected) {
    if (size + message.text.length > 65_536) {
      frames.push({ type: "history", conversation_id: id, messages, next_cursor: null, page_complete: false }); messages = []; size = 0;
    }
    messages.push(message); size += message.text.length;
  }
  frames.push({ type: "history", conversation_id: id, messages, next_cursor, page_complete: true });
  return frames;
}

/** Forward exposed activity and native compaction status, without summary payloads. */
export async function activity(session: Harness, conversation: Conversation, emit: (event: ModelActivity) => void,
  message?: (message: HistoryMessage) => void): Promise<() => Promise<void>> {
  const stream = await watchEvents(session, conversation.id, BACKGROUND_CONTEXT);
  const thinking = new Map<number, string>();
  const compactions = new Set<string>();
  let compacting = false, compactionFailure = stream.snapshot.compactionFailure?.taskId.toString();
  const reportCompaction = (failed = false) => {
    const active = compactions.size > 0;
    if (active !== compacting || failed) { compacting = active; emit({ type: "compaction", active, failed }); }
  };
  for (const status of stream.snapshot.compactions) compactions.add(status.taskId.toString());
  reportCompaction();
  let assistantOpen = false;
  const update = (index: number, text: string) => {
    const previous = thinking.get(index) ?? "";
    const append = text.startsWith(previous) ? text.slice(previous.length) : "\n" + text;
    thinking.set(index, text);
    for (const chunk of chunks(append)) emit({ type: "thinking", text: chunk });
  };
  stream.start(async (events) => {
    for (const event of events) {
      if (event.type === "snapshot") {
        compactions.clear();
        for (const status of event.compactions) compactions.add(status.taskId.toString());
        const failure = event.compactionFailure?.taskId.toString();
        reportCompaction(failure !== undefined && failure !== compactionFailure);
        compactionFailure = failure;
      } else if (event.type === "compaction_start") {
        compactions.add(event.taskId.toString()); reportCompaction();
      } else if (event.type === "compaction_end") {
        compactions.delete(event.taskId.toString());
        if (event.error !== undefined) compactionFailure = event.taskId.toString();
        reportCompaction(event.error !== undefined);
      } else if (event.type === "message_start") {
        if (event.message.role === "assistant") {
          if (!assistantOpen) thinking.clear();
          assistantOpen = true;
          event.message.content.forEach((part, index) => { if (part.type === "thinking") update(index, part.thinking); });
        }
      } else if (event.type === "message_update") {
        const whole = new Set(event.changes.flatMap((change) => (change.type === "thinking_start" || change.type === "block") && change.block.type === "thinking" ? [change.contentIndex] : []));
        for (const change of event.changes) {
          if (change.type === "thinking_delta" && !whole.has(change.contentIndex)) update(change.contentIndex, (thinking.get(change.contentIndex) ?? "") + change.delta);
          else if ((change.type === "thinking_start" || change.type === "block") && change.block.type === "thinking") update(change.contentIndex, change.block.thinking);
          else if (change.type === "message") change.message.content.forEach((part, index) => {
            if (part.type === "thinking") update(index, part.thinking);
          });
        }
      } else if (event.type === "message_end") {
        for (const item of transcript(event.entry)) if (item.role === "user" || item.role === "commentary" || item.tool !== undefined) message?.(item);
        for (const message of event.entry.model ?? []) if (message.role === "assistant") message.content.forEach((part, index) => {
          if (part.type === "thinking") update(index, part.thinking);
        });
        if (event.entry.model?.some((message) => message.role === "assistant")) assistantOpen = false;
      } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        emit({ type: event.type === "tool_execution_start" ? "tool_started" : "tool_finished",
          call_id: event.toolCallId, name: event.toolName });
      }
    }
  });
  return async () => {
    try { await stream.stop(); }
    finally {
      // Detaching ends this status observation, not Pi's compaction task.
      compactions.clear(); reportCompaction();
    }
  };
}
