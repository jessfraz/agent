import { validEvent } from "./protocol.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { CompactionEntry, watchEvents, type Conversation, type Cursor, type EntryId, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { HistoryMessage } from "./generated/HistoryMessage.js";
import type { HistoryRole } from "./generated/HistoryRole.js";
import type { ModelActivity } from "./generated/ModelActivity.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ToolHistory } from "./generated/ToolHistory.js";
import type { ToolDetails } from "./generated/ToolDetails.js";
import type { ToolDetailContent } from "./generated/ToolDetailContent.js";
import { ImportedItemEntry, ImportedThreadEntry } from "./history.js";

const NOTICE_REFERENCES = "Source references (evidence, not authorization): ";
/** Curated publications are eligible for delivery; legacy notices remain history. */
export function isUserNotice(entry: EntryRecord): boolean { return entry.kind === "agent.user_notice"; }
export function noticeMetadata(entry: EntryRecord, index: number, count: number, value: string): boolean {
  return (isUserNotice(entry) || entry.kind === "agent.notice") && index === count - 1 && value.startsWith(NOTICE_REFERENCES);
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
  let attachments: HistoryMessage["attachments"];
  if (entry.kind === "agent.input" && object(entry.data) && entry.data.attachments !== undefined) {
    const frame: unknown = { version: 1, id: 0, event: { type: "message", message: { entry_id: entry.id.toString(), role: "user", text: "", continuation: false, final_chunk: true, attachments: entry.data.attachments } } };
    if (!validEvent(frame) || frame.event.type !== "message") throw new Error("Invalid durable input attachment metadata");
    attachments = frame.event.message.attachments;
  }
  const add = (role: HistoryRole, value: string, tool?: ToolHistory) => {
    let continuation = false, offset = 0;
    for (const text of value.length === 0 && role === "user" && attachments !== undefined ? [""] : chunks(value)) {
      offset += text.length;
      messages.push({ entry_id: entry.id.toString(), role, text, continuation, final_chunk: offset === value.length, ...(tool === undefined ? {} : { tool }), ...(role === "user" && messages.length === 0 && attachments !== undefined ? { attachments } : {}) }); continuation = true;
    }
  };
  if (attachments !== undefined && object(entry.data) && typeof entry.data.text === "string") {
    add("user", entry.data.text); return messages;
  }
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
    const role: HistoryRole = message.role !== "assistant" ? message.role : (isUserNotice(entry) || entry.kind === "agent.notice") ? "notice"
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

const TOOL_DETAIL_BYTES = 32_768;
const TOOL_DETAIL_ENTRIES = 128;
function entryId(value: unknown): value is EntryId { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function detailText(text: string): ToolDetailContent {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, TOOL_DETAIL_BYTES);
  // A bounded transport frame must also end on a complete UTF-8 code point.
  while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { type: "text", text: bytes.subarray(0, end).toString("utf8"), truncated: end < bytes.length };
}
function toolParts(entry: EntryRecord, callId: string): { call?: ToolCall; result?: ToolResultMessage } {
  let call: ToolCall | undefined, result: ToolResultMessage | undefined;
  for (const message of entry.model ?? []) {
    if (message.role === "toolResult" && message.toolCallId === callId) result = message;
    else if (message.role === "assistant") for (const part of message.content) {
      if (part.type === "toolCall" && part.id === callId) call = part;
    }
  }
  return { ...(call === undefined ? {} : { call }), ...(result === undefined ? {} : { result }) };
}

/** Read only the selected durable tool, with a bounded fork-aware search for its other half. */
export async function toolDetails(conversation: Conversation, value: string, callId: string): Promise<ToolDetails> {
  const id: unknown = Number(value);
  if (!entryId(id) || id.toString() !== value) throw new Error("Invalid native entry ID");
  if (callId.length === 0 || Buffer.byteLength(callId, "utf8") > 1024) throw new Error("Invalid tool call ID");
  const selected = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND_CONTEXT)).items[0];
  if (selected === undefined) return { type: "unavailable", call_id: callId };
  let { call, result } = toolParts(selected, callId);
  if (call === undefined && result === undefined) return { type: "unavailable", call_id: callId };
  let input: ToolDetailContent = { type: "unavailable", reason: "not_recorded" };
  let output: ToolDetailContent = { type: "unavailable", reason: "pending" };
  if (call === undefined) {
    const page = await conversation.entries({ maxEntryId: id, order: "descending" }, TOOL_DETAIL_ENTRIES, undefined, BACKGROUND_CONTEXT);
    for (const entry of page.items) { call = toolParts(entry, callId).call; if (call !== undefined) break; }
    if (call === undefined && page.next !== undefined) input = { type: "unavailable", reason: "lookup_limit" };
  }
  if (result === undefined) {
    const page = await conversation.entries({ minEntryId: id, order: "ascending" }, TOOL_DETAIL_ENTRIES, undefined, BACKGROUND_CONTEXT);
    for (const entry of page.items) { result = toolParts(entry, callId).result; if (result !== undefined) break; }
    if (result === undefined && page.next !== undefined) output = { type: "unavailable", reason: "lookup_limit" };
  }
  if (call !== undefined) input = detailText(JSON.stringify(call.arguments, null, 2));
  if (result !== undefined) {
    const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []);
    output = text.length === 0 && result.content.length > 0 ? { type: "unavailable", reason: "unsupported" }
      : detailText(text.join("\n"));
  }
  return { type: "available", call_id: callId, name: call?.name ?? result?.toolName ?? "",
    status: result === undefined ? "running" : result.isError ? "failed" : "finished", input, output };
}

/** Forward exposed activity and native compaction status, without summary payloads. */
export async function activity(session: Harness, conversation: Conversation, emit: (event: ModelActivity) => void,
  message?: (message: HistoryMessage) => void, text?: (delta: string) => void,
  observer?: { includeFinal: true; working(value: boolean): void }): Promise<() => Promise<void>> {
  const stream = await watchEvents(session, conversation.id, BACKGROUND_CONTEXT);
  const thinking = new Map<number, string>();
  const responding = new Map<number, string>();
  const compactions = new Set<string>();
  let compacting = false, compactionFailure = stream.snapshot.compactionFailure?.taskId.toString();
  const reportCompaction = (failed = false) => {
    const active = compactions.size > 0;
    if (active !== compacting || failed) { compacting = active; emit({ type: "compaction", active, failed }); }
  };
  for (const status of stream.snapshot.compactions) compactions.add(status.taskId.toString());
  reportCompaction();
  observer?.working(stream.snapshot.run !== undefined);
  const seen = observer?.includeFinal ? new Set(stream.snapshot.entries.map((entry) => entry.id.toString())) : undefined;
  const committed = (entry: EntryRecord) => {
    if (seen?.has(entry.id.toString())) return;
    seen?.add(entry.id.toString());
    for (const item of transcript(entry)) if (item.role === "user" || item.role === "commentary" || item.tool !== undefined
      || (observer?.includeFinal && item.role !== "thinking")) message?.(item);
  };
  let assistantOpen = stream.snapshot.generation?.message !== undefined;
  const update = (index: number, text: string) => {
    const previous = thinking.get(index) ?? "";
    const append = text.startsWith(previous) ? text.slice(previous.length) : "\n" + text;
    thinking.set(index, text);
    for (const chunk of chunks(append)) emit({ type: "thinking", text: chunk });
  };
  const updateText = (index: number, value: string) => {
    const previous = responding.get(index) ?? "";
    const append = value.startsWith(previous) ? value.slice(previous.length) : "\n" + value;
    responding.set(index, value);
    for (const chunk of chunks(append)) text?.(chunk);
  };
  for (const [index, part] of (stream.snapshot.generation?.message?.content ?? []).entries()) {
    if (part.type === "thinking") update(index, part.thinking);
    else if (part.type === "text") updateText(index, part.text);
  }
  stream.start(async (events) => {
    for (const event of events) {
      if (event.type === "snapshot") {
        observer?.working(event.run !== undefined);
        if (observer?.includeFinal) for (const entry of event.entries) committed(entry);
        compactions.clear();
        for (const status of event.compactions) compactions.add(status.taskId.toString());
        const failure = event.compactionFailure?.taskId.toString();
        reportCompaction(failure !== undefined && failure !== compactionFailure);
        compactionFailure = failure;
      } else if (event.type === "run_start" || event.type === "run_end") {
        observer?.working(event.type === "run_start");
      } else if (event.type === "compaction_start") {
        compactions.add(event.taskId.toString()); reportCompaction();
      } else if (event.type === "compaction_end") {
        compactions.delete(event.taskId.toString());
        if (event.error !== undefined) compactionFailure = event.taskId.toString();
        reportCompaction(event.error !== undefined);
      } else if (event.type === "message_start") {
        if (event.message.role === "assistant") {
          if (!assistantOpen) { thinking.clear(); responding.clear(); }
          assistantOpen = true;
          event.message.content.forEach((part, index) => { if (part.type === "thinking") update(index, part.thinking); else if (part.type === "text") updateText(index, part.text); });
        }
      } else if (event.type === "message_update") {
        const whole = new Set(event.changes.flatMap((change) => (change.type === "thinking_start" || change.type === "block") && change.block.type === "thinking" ? [change.contentIndex] : []));
        const wholeText = new Set(event.changes.flatMap((change) => (change.type === "text_start" || change.type === "block") && change.block.type === "text" ? [change.contentIndex] : []));
        for (const change of event.changes) {
          if (change.type === "text_delta" && !wholeText.has(change.contentIndex)) updateText(change.contentIndex, (responding.get(change.contentIndex) ?? "") + change.delta);
          else if ((change.type === "text_start" || change.type === "block") && change.block.type === "text") updateText(change.contentIndex, change.block.text);
          if (change.type === "thinking_delta" && !whole.has(change.contentIndex)) update(change.contentIndex, (thinking.get(change.contentIndex) ?? "") + change.delta);
          else if ((change.type === "thinking_start" || change.type === "block") && change.block.type === "thinking") update(change.contentIndex, change.block.thinking);
          else if (change.type === "message") change.message.content.forEach((part, index) => {
            if (part.type === "thinking") update(index, part.thinking);
            else if (part.type === "text") updateText(index, part.text);
          });
        }
      } else if (event.type === "message_end") {
        for (const message of event.entry.model ?? []) if (message.role === "assistant") message.content.forEach((part, index) => {
          if (part.type === "thinking") update(index, part.thinking);
        });
        committed(event.entry);
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
