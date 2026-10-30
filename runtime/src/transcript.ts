import { validEvent } from "./protocol.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { CompactionEntry, LiveDoc, type Conversation, type Cursor, type DocumentWatch, type EntryId, type EntryRecord,
  type Harness, type JsonObject, type LiveState } from "@earendil-works/pi-durable";
import type { HistoryMessage } from "./generated/HistoryMessage.js";
import type { HistoryRole } from "./generated/HistoryRole.js";
import type { ModelActivity } from "./generated/ModelActivity.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ToolDetails } from "./generated/ToolDetails.js";
import type { ToolDetailContent } from "./generated/ToolDetailContent.js";
import type { MessagePresentation } from "./generated/MessagePresentation.js";
import { HistoryError, HistoryStore, ImportedItemEntry, ImportedThreadEntry, isHistoryEntry } from "./history.js";
import { codexDisplayMessage, codexMessage, codexToolOutput, historyToolId } from "./imported-history.js";
import { field, piToolPresentation, piToolResult, string, type MessageContent } from "./message-presentation.js";
import { observeTranscriptVisibility, readTranscriptVisibility, transcriptVisible, type TranscriptVisibilityState } from "./transcript_visibility.js";
import { REVISION_AMBIGUOUS, REVISION_PENDING, revisionStatus, type RevisionView } from "./history-revisions.js";

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
function cursor(value: string | null, conversationId: string): { cursor?: Cursor; max_entry_id?: EntryId } {
  if (value === null) return {};
  const decoded: unknown = JSON.parse(value);
  if (!object(decoded) || decoded.conversation_id !== conversationId || !object(decoded.cursor) || !json(decoded.cursor)) {
    throw new Error("History cursor does not belong to this conversation");
  }
  if (decoded.max_entry_id !== undefined && !entryId(decoded.max_entry_id)) throw new Error("Invalid history snapshot cutoff");
  return { cursor: decoded.cursor, ...(decoded.max_entry_id === undefined ? {} : { max_entry_id: decoded.max_entry_id }) };
}
function* chunks(value: string): Generator<string> {
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 8192, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield value.slice(offset, end); offset = end;
  }
}
export function visibleTranscript(entry: EntryRecord, visibility: Readonly<TranscriptVisibilityState> | undefined,
  tools?: Map<string, MessagePresentation>): HistoryMessage[] {
  return transcriptVisible(entry.id.toString(), visibility) ? nativeTranscript(entry, tools) : [];
}
function missingOriginal(error: unknown): boolean {
  return error instanceof HistoryError || (error instanceof Error && "code" in error &&
    ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].some((code) => error.code === code));
}
/** Source adapters converge here, including verified cold originals retained by older imports. */
export async function projectTranscript(entry: EntryRecord, originals: Pick<HistoryStore, "original">,
  visibility?: Readonly<TranscriptVisibilityState>, revisions?: RevisionView, tools?: Map<string, MessagePresentation>): Promise<HistoryMessage[]> {
  if (!transcriptVisible(entry.id.toString(), visibility)) return [];
  if (!ImportedItemEntry.is(entry)) return nativeTranscript(entry, tools);
  const status = revisions === undefined ? "current" : revisionStatus(entry.id, revisions);
  if (status === "superseded" || status === "outside_snapshot") return [];
  let message: MessageContent;
  try { message = codexDisplayMessage(entry.data.item, await originals.original(entry), entry.id.toString()); }
  catch (error) {
    if (!missingOriginal(error)) throw error;
    message = { role: entry.data.item.role, text: entry.data.item.role === "tool" ? "" : entry.data.item.text,
      presentation: { type: "unavailable", kind: entry.data.item.kind } };
  }
  const rows = messageRows(entry, message);
  if (rows.length > 0 && status === "ambiguous") rows.unshift({ entry_id: entry.id.toString(), role: "notice",
    text: `${REVISION_AMBIGUOUS} (${entry.data.item.version.slice(0, 12)})`,
    continuation: false, final_chunk: true });
  return rows;
}
function messageRows(entry: EntryRecord, message: MessageContent): HistoryMessage[] {
  const value = message.text; let offset = 0, continuation = false;
  return (value.length === 0 && message.presentation !== undefined ? [""] : [...chunks(value)]).map((text) => {
    offset += text.length;
    const row: HistoryMessage = { entry_id: entry.id.toString(), role: message.role, text, continuation, final_chunk: offset === value.length,
      ...(message.tool === undefined ? {} : { tool: message.tool }),
      ...(message.presentation === undefined || continuation ? {} : { presentation: message.presentation }) };
    continuation = true; return row;
  });
}
export function transcript(entry: EntryRecord): HistoryMessage[] { return nativeTranscript(entry); }
function nativeTranscript(entry: EntryRecord, tools?: Map<string, MessagePresentation>): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  let attachments: HistoryMessage["attachments"];
  if (entry.kind === "agent.input" && object(entry.data) && entry.data.attachments !== undefined) {
    const frame: unknown = { version: 1, id: 0, event: { type: "message", message: { entry_id: entry.id.toString(), role: "user", text: "", continuation: false, final_chunk: true, attachments: entry.data.attachments } } };
    if (!validEvent(frame) || frame.event.type !== "message") throw new Error("Invalid durable input attachment metadata");
    attachments = frame.event.message.attachments;
  }
  const add = (role: HistoryRole, value: string) => {
    let continuation = false, offset = 0;
    for (const text of value.length === 0 && role === "user" && attachments !== undefined ? [""] : chunks(value)) {
      offset += text.length;
      messages.push({ entry_id: entry.id.toString(), role, text, continuation, final_chunk: offset === value.length,
        ...(role === "user" && messages.length === 0 && attachments !== undefined ? { attachments } : {}) }); continuation = true;
    }
  };
  if (attachments !== undefined && object(entry.data) && typeof entry.data.text === "string") {
    add("user", entry.data.text); return messages;
  }
  if (ImportedItemEntry.is(entry)) {
    return messageRows(entry, codexDisplayMessage(entry.data.item, entry.data.item.data, entry.id.toString()));
  }
  if (ImportedThreadEntry.is(entry) || CompactionEntry.is(entry)) return messages;
  for (const message of entry.model ?? []) {
    if (message.role === "system") continue;
    if (message.role === "toolResult") {
      messages.push(...messageRows(entry, piToolResult(message, entry.conversationId.toString(), tools?.get(message.toolCallId))));
      tools?.delete(message.toolCallId); continue;
    }
    const role: HistoryRole = message.role !== "assistant" ? message.role : (isUserNotice(entry) || entry.kind === "agent.notice") ? "notice"
      : message.stopReason === "toolUse" ? "commentary" : message.stopReason === "stop" ? "final" : "assistant";
    if (typeof message.content === "string") { add(role, message.content); continue; }
    for (const [index, part] of message.content.entries()) {
      if (part.type === "text" && !noticeMetadata(entry, index, message.content.length, part.text)) add(role, part.text);
      else if (part.type === "thinking") add("thinking", part.thinking);
      else if (part.type === "toolCall") {
        const presentation = piToolPresentation(part, entry.conversationId.toString());
        tools?.set(part.id, presentation);
        messages.push(...messageRows(entry, { role: "tool", text: "", tool: { call_id: part.id, name: part.name, status: "running" }, presentation }));
      }
      else if (part.type === "image") add("user", "[image]");
    }
  }
  return messages;
}

/** Native fork-aware pages, rendered without loading history back into model input. */
export async function history(conversation: Conversation, value: string | null, reader: Harness): Promise<Extract<RuntimeEventKind, { type: "history" }>[]> {
  const id = conversation.id.toString();
  const visibility = await readTranscriptVisibility(reader, conversation.id);
  const originals = new HistoryStore(reader);
  const revisions = new Map<string, RevisionView>();
  const pending = new Set<string>();
  const saved = cursor(value, id);
  const maximum = value === null ? (await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id : saved.max_entry_id;
  let next = saved.cursor; let projected: HistoryMessage[];
  // Native pages count entries, including hidden compaction and import metadata.
  // Keep following their cursors until this page has something to show or ends.
  do {
    const page = await conversation.entries({ order: "descending", ...(maximum === undefined ? {} : { maxEntryId: maximum }) }, 20, next, BACKGROUND_CONTEXT);
    projected = [];
    const tools = new Map<string, MessagePresentation>();
    for (const entry of [...page.items].reverse()) {
      let view: RevisionView | undefined;
      if (ImportedItemEntry.is(entry)) {
        view = revisions.get(entry.data.thread_id);
        if (view === undefined) {
          view = await originals.revisionView(entry.data.thread_id);
          if (maximum !== undefined && view.watermark !== null && view.watermark > maximum) view = { ...view, ready: false };
          revisions.set(entry.data.thread_id, view);
        }
      }
      const rows = await projectTranscript(entry, originals, visibility, view, tools);
      if (rows.length > 0 && view !== undefined && !view.ready && ImportedItemEntry.is(entry) && !pending.has(entry.data.thread_id)) {
        projected.push({ entry_id: entry.id.toString(), role: "notice", text: REVISION_PENDING, continuation: false, final_chunk: true }); pending.add(entry.data.thread_id);
      }
      projected.push(...rows);
    }
    next = page.next;
    // The client pages history in the background. A superseded source tail
    // must not turn its first bounded request into a full ledger scan.
    if (projected.length === 0 && page.items.some(isHistoryEntry)) break;
  } while (projected.length === 0 && next !== undefined);
  const next_cursor = next === undefined ? null : JSON.stringify({ conversation_id: id, cursor: next,
    ...(maximum === undefined ? {} : { max_entry_id: maximum }) });
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
export async function toolDetails(conversation: Conversation, value: string, callId: string, session: Harness): Promise<ToolDetails> {
  const id: unknown = Number(value);
  if (!entryId(id) || id.toString() !== value) throw new Error("Invalid native entry ID");
  if (callId.length === 0 || Buffer.byteLength(callId, "utf8") > 1024) throw new Error("Invalid tool call ID");
  const selected = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND_CONTEXT)).items[0];
  if (selected === undefined) return { type: "unavailable", call_id: callId };
  if (ImportedItemEntry.is(selected)) {
    if (historyToolId(selected.id.toString()) !== callId) return { type: "unavailable", call_id: callId };
    let original;
    try { original = await new HistoryStore(session).original(selected); }
    catch (error) { if (missingOriginal(error)) return { type: "unavailable", call_id: callId }; throw error; }
    const canonical = codexMessage(selected.data.item, original, selected.id.toString());
    if (canonical.tool === undefined) return { type: "unavailable", call_id: callId };
    const input = field(original, "command") ?? field(original, "arguments") ?? field(original, "changes") ?? field(original, "prompt");
    const agents = field(original, "agentsStates");
    const aggregated = string(field(original, "aggregatedOutput")), projected = codexToolOutput(selected.data.item, original);
    const output = aggregated ?? (projected.text ||
      (string(field(field(original, "error"), "message")) ?? (agents === undefined ? null : JSON.stringify(agents, null, 2))));
    const inspected: ToolDetailContent = output === null || output === undefined ? { type: "unavailable", reason: "not_recorded" } : detailText(output);
    // Inspection's byte limit cannot erase an earlier per-part display cutoff.
    if (aggregated === null && projected.text.length > 0 && projected.truncated && inspected.type === "text") inspected.truncated = true;
    return { type: "available", call_id: callId, name: canonical.tool.name, status: canonical.tool.status,
      input: input === undefined ? { type: "unavailable", reason: "not_recorded" } : detailText(typeof input === "string" ? input : JSON.stringify(input, null, 2)),
      output: inspected };
  }
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

/** Forward live state and new native entries without mounting historical model context. */
export async function activity(session: Harness, conversation: Conversation, emit: (event: ModelActivity) => void,
  message?: (message: HistoryMessage) => void, text?: (delta: string) => void,
  observer?: { includeFinal: true; working(value: boolean): void }): Promise<() => Promise<void>> {
  const visibility = await observeTranscriptVisibility(session, conversation.id);
  const thinking = new Map<number, string>(), responding = new Map<number, string>();
  // Retain only typed headings while their native calls are pending, never arguments.
  const tools = new Map<string, MessagePresentation>();
  let previous: Readonly<LiveState> | null = null, initialized = false, assistantOpen = false;
  let compacting = false;
  const compaction = (active: boolean, failed = false) => {
    if (active !== compacting || failed) { compacting = active; emit({ type: "compaction", active, failed }); }
  };
  const update = (parts: Map<number, string>, index: number, value: string, deliver: (value: string) => void) => {
    const before = parts.get(index) ?? "";
    const append = value.startsWith(before) ? value.slice(before.length) : "\n" + value;
    parts.set(index, value);
    for (const chunk of chunks(append)) deliver(chunk);
  };
  const partial = (content: AssistantMessage["content"]) => {
    if (!assistantOpen) { thinking.clear(); responding.clear(); assistantOpen = true; }
    content.forEach((part, index) => {
      if (part.type === "thinking") update(thinking, index, part.thinking, (value) => emit({ type: "thinking", text: value }));
      else if (part.type === "text") update(responding, index, part.text, (value) => text?.(value));
    });
  };
  const committed = (entry: EntryRecord) => {
    const notice = isUserNotice(entry) || entry.kind === "agent.notice";
    if (!notice && transcriptVisible(entry.id.toString(), visibility.state())) for (const value of entry.model ?? []) {
      if (value.role !== "assistant") continue;
      if (!assistantOpen) { thinking.clear(); responding.clear(); }
      value.content.forEach((part, index) => {
        if (part.type === "thinking") update(thinking, index, part.thinking, (value) => emit({ type: "thinking", text: value }));
        else if (part.type === "text") {
          update(responding, index, part.text, (value) => text?.(value));
        }
      });
    }
    for (const item of visibleTranscript(entry, visibility.state(), tools)) if (item.role === "user" || item.role === "commentary" || item.tool !== undefined
      || (observer?.includeFinal && item.role !== "thinking")) message?.(item);
    if (!notice && entry.model?.some((value) => value.role === "assistant")) assistantOpen = false;
  };
  const live = (value: Readonly<LiveState> | null) => {
    if (value === null) assistantOpen = false;
    const idle = initialized && previous?.run !== undefined && value?.run === undefined;
    if (!initialized || (previous?.run === undefined && value?.run !== undefined)) observer?.working(value?.run !== undefined);
    const before = [...previous?.tools ?? [], ...previous?.nestedTools ?? []];
    const next = [...value?.tools ?? [], ...value?.nestedTools ?? []];
    if (initialized) {
      for (const slot of next) if (slot.status === "running" && before.find((old) => old.callId === slot.callId)?.status !== "running") {
        emit({ type: "tool_started", call_id: slot.callId, name: slot.name });
      }
      for (const slot of [...before].reverse()) if (slot.status !== "done" && (next.find((item) => item.callId === slot.callId)?.status ?? "done") === "done") {
        emit({ type: "tool_finished", call_id: slot.callId, name: slot.name });
      }
      for (const slot of next) if (slot.status === "done" && !before.some((old) => old.callId === slot.callId)) {
        emit({ type: "tool_finished", call_id: slot.callId, name: slot.name });
      }
    }
    const failure = value?.compactionFailure?.taskId;
    compaction((value?.compactions?.length ?? 0) > 0, initialized && failure !== undefined && failure !== previous?.compactionFailure?.taskId);
    if (value?.generation?.message !== undefined) partial(value.generation.message.content);
    previous = value; initialized = true;
    return idle;
  };

  type Frame = { entries: EntryRecord[]; expected?: JsonObject | null };
  const pending: Frame[] = [];
  let watch: DocumentWatch<LiveState> | undefined, acquiring: Promise<void> | undefined;
  let ready = false, stopped = false, failure: unknown, cutoff = 0;
  const drain = () => {
    if (!ready || stopped) return;
    while (pending[0]?.expected === undefined) {
      const frame = pending.shift(); if (frame === undefined) break;
      for (const entry of frame.entries) if (entry.id > cutoff) committed(entry);
    }
  };
  const accept = (value: Readonly<LiveState> | null, initial = false) => {
    if (stopped) return;
    // Pinned Pi 1.4 publishes the same immutable value to commit subscribers
    // and typed document watches. Joining those identities keeps final thinking
    // ahead of its canonical entry without decoding or casting Pi's state.
    const index = pending.findIndex((frame) => frame.expected === value);
    if (index < 0) { if (initial && live(value)) observer?.working(false); return; }
    for (const frame of pending.splice(0, index + 1)) {
      const idle = frame.expected === value && live(value);
      for (const entry of frame.entries) if (entry.id > cutoff) committed(entry);
      // Pi's answer and endRun share a commit. Canonical identity must reach
      // the renderer before idle releases its unbound reasoning preview.
      if (idle) observer?.working(false);
    }
    drain();
  };
  let unsubscribe = () => {}, unsubscribeClose = () => {};
  const close = async () => {
    if (stopped) return;
    stopped = true; unsubscribe(); unsubscribeClose(); visibility.close(); pending.length = 0; tools.clear();
    const owned = watch, loading = acquiring; watch = undefined;
    await owned?.stop();
    await loading?.catch(() => {});
    compaction(false);
  };
  const failed = (error: unknown) => { failure = error; void close(); };
  const acquire = (): Promise<void> => {
    if (acquiring !== undefined) return acquiring;
    const operation = (async () => {
      const owned = await session.watchDoc(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
      if (stopped) { await owned?.stop(); return; }
      watch = owned;
      if (owned === undefined) {
        // Creation and retirement may both precede acquisition. Canonical
        // entries remain available even when that transient incarnation is gone.
        accept(null, true); drain(); return;
      }
      accept(owned.value, true);
      owned.start(async (value) => {
        accept(value);
        if (value === null && watch === owned) {
          watch = undefined;
          queueMicrotask(() => { if (!stopped) void acquire().catch(failed); });
        }
      });
      void owned.closed.then((result) => { if (result.reason === "listener_error") failed(result.error); });
    })();
    acquiring = operation;
    void operation.finally(() => {
      if (acquiring === operation) acquiring = undefined;
      if (!stopped && watch === undefined && pending.some((frame) => frame.expected !== undefined && frame.expected !== null)) {
        queueMicrotask(() => { if (!stopped) void acquire().catch(failed); });
      }
    }).catch(() => {});
    return operation;
  };
  unsubscribe = session.subscribeCommits((publication) => {
    const entries = publication.changes.flatMap((change) => change.type === "entry" && change.value.conversationId === conversation.id ? [change.value] : []);
    const changed = publication.changes.find((change) => change.type === "document" && change.record.kind === LiveDoc.definition.kind && change.conversationId === conversation.id);
    if (entries.length === 0 && changed === undefined) return;
    if (pending.length >= 512) { failed(new Error("Activity observation fell behind; reconnect to recover saved history.")); return; }
    const expected = changed?.type === "document" && (changed.ops.length > 0 || changed.value === null || changed.record.createdAt === publication.seq) ? changed.value : undefined;
    pending.push({ entries, ...(expected === undefined ? {} : { expected }) });
    drain();
    if (watch === undefined && acquiring === undefined && expected !== undefined && expected !== null) {
      queueMicrotask(() => { if (!stopped) void acquire().catch(failed); });
    }
  });
  unsubscribeClose = session.subscribeClose(() => { void close(); });
  try {
    // One bounded native tail, not the active transcript/model-context mount.
    cutoff = (await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? 0;
    await acquire(); ready = true; drain();
    if (failure !== undefined) throw failure;
  } catch (error) { await close(); throw error; }
  return async () => { await close(); if (failure !== undefined) throw failure; };
}
