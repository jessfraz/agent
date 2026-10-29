import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { FeedbackBundle } from "./generated/FeedbackBundle.js";
import type { FeedbackContext } from "./generated/FeedbackContext.js";
import type { FeedbackEntry } from "./generated/FeedbackEntry.js";
import type { FeedbackEvidence } from "./generated/FeedbackEvidence.js";
import { DelegationDecisionEntry } from "./delegation.js";
import { AllocationDecisionEntry } from "./allocation.js";
import { TaskStore } from "./tasks.js";

const SAFE_DECISIONS = new Set(["search_tasks", "delegate_task", "spawn_agent", "continue_agent", "record_task", "report_result", "read_agents", "wait_agents"]);
const OMITTED_TOOL = "Payload omitted: execution, files, provider/auth and unknown tool output may contain credentials. Follow the canonical entry/call ID when needed.";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Minimize known credential forms, without pretending arbitrary prose is secret-free. */
function redact(value: string): string {
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/((?:password|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[redacted]");
}

class Capture {
  remaining = 131_072;
  evidence = 160;
  truncated = false;
  text(value: string, limit = 8192): string {
    const bytes = Buffer.from(redact(value)); const allowed = Math.min(limit, this.remaining);
    let end = Math.min(bytes.length, allowed);
    // Do not split a UTF-8 character in the diagnostic file or transport frame.
    while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    this.remaining -= end;
    if (end < bytes.length) this.truncated = true;
    return bytes.subarray(0, end).toString("utf8");
  }
}

async function privateWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

function diagnostic(entry: EntryRecord, capture: Capture): FeedbackEntry {
  const evidence: FeedbackEvidence[] = [];
  if (AllocationDecisionEntry.is(entry)) {
    if (capture.evidence <= 0) { capture.truncated = true; return { entry_id: entry.id.toString(), kind: entry.kind, evidence }; }
    capture.evidence -= 1;
    const decision = { ...entry.data, reason: capture.text(entry.data.reason, 2048),
      result: entry.data.result.type === "failed" ? { ...entry.data.result, message: capture.text(entry.data.result.message, 2048) } : entry.data.result };
    // Keep typed identities intact. Omit a receipt that cannot fit or contains
    // credential forms elsewhere, rather than emitting partial lifecycle state.
    const serialized = JSON.stringify(decision);
    if (capture.text(serialized, 131_072) === serialized) evidence.push({ type: "allocation", decision });
    else capture.truncated = true;
  }
  if (DelegationDecisionEntry.is(entry)) {
    const decision = entry.data;
    if (capture.evidence <= 0) { capture.truncated = true; return { entry_id: entry.id.toString(), kind: entry.kind, evidence }; }
    capture.evidence -= 1;
    if (decision.candidates.length > 16 || decision.gaps.length > 8) capture.truncated = true;
    evidence.push({ type: "delegation", decision: { ...decision,
      query: decision.query === null ? null : capture.text(decision.query),
      candidates: decision.candidates.slice(0, 16), gaps: decision.gaps.slice(0, 8).map((gap) => capture.text(gap, 1024)),
      selection: decision.selection.kind === "create" ? { ...decision.selection,
        reason: decision.selection.reason === null ? null : capture.text(decision.selection.reason) } : decision.selection } });
  }
  for (const message of entry.model ?? []) {
    if (capture.evidence <= 0) { capture.truncated = true; break; }
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.errorMessage !== undefined) {
      evidence.push({ type: "message", role: "assistant", text: capture.text(`Model ${message.stopReason}: ${message.errorMessage}`) });
      capture.evidence -= 1;
    }
    if (message.role === "toolResult") {
      const safe = SAFE_DECISIONS.has(message.toolName);
      const text = safe ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : null;
      evidence.push({ type: "tool_result", tool_call_id: message.toolCallId, name: message.toolName,
        is_error: message.isError, text: text === null ? null : capture.text(text), omitted: safe ? null : OMITTED_TOOL });
      capture.evidence -= 1; continue;
    }
    if (typeof message.content === "string") {
      evidence.push({ type: "message", role: message.role, text: capture.text(message.content) }); capture.evidence -= 1; continue;
    }
    for (const part of message.content) {
      if (capture.evidence <= 0) { capture.truncated = true; break; }
      if (part.type === "text") evidence.push({ type: "message", role: message.role, text: capture.text(part.text) });
      else if (part.type === "thinking" && part.redacted !== true) {
        evidence.push({ type: "message", role: "thinking", text: capture.text(part.thinking) });
      }
      else if (part.type === "toolCall") {
        const safe = SAFE_DECISIONS.has(part.name);
        evidence.push({ type: "tool_call", tool_call_id: part.id, name: part.name,
          arguments: safe ? capture.text(JSON.stringify(part.arguments)) : null, omitted: safe ? null : OMITTED_TOOL });
      }
      if (part.type === "text" || part.type === "toolCall" || (part.type === "thinking" && part.redacted !== true)) capture.evidence -= 1;
      // Thinking signatures, encrypted state, media bytes and system instructions are never copied.
    }
  }
  return { entry_id: entry.id.toString(), kind: entry.kind, evidence };
}

/** Private snapshots reuse native Pi evidence. Capturing never runs a model or a host command. */
export class FeedbackStore {
  private readonly directory: string;
  private readonly capturing = new Map<string, Promise<FeedbackBundle>>();
  constructor(state: string, private readonly tasks: TaskStore) { this.directory = join(state, "feedback"); }

  async capture(description: string, input: FeedbackContext, inputId?: string): Promise<FeedbackBundle> {
    if (inputId === undefined) return this.captureNew(description, input);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inputId) || inputId === "00000000-0000-0000-0000-000000000000") throw new Error("Feedback needs a nonnil UUID request ID");
    const operation = this.capturing.get(inputId) ?? this.captureNew(description, input, inputId);
    this.capturing.set(inputId, operation);
    try {
      const saved = await operation;
      if (saved.description !== new Capture().text(description, 4096) ||
        JSON.stringify(saved.context.attachments ?? []) !== JSON.stringify(input.attachments ?? [])) throw new Error("A feedback request ID cannot be reused with different content");
      return saved;
    } finally { if (this.capturing.get(inputId) === operation) this.capturing.delete(inputId); }
  }
  private async captureNew(description: string, input: FeedbackContext, inputId?: string): Promise<FeedbackBundle> {
    if (inputId !== undefined) {
      try { return await this.read(inputId); } catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; }
    }
    if (description.trim().length === 0) throw new Error("Describe the issue after /feedback.");
    if (input.origin_host_id.length === 0) throw new Error("Feedback needs the originating execution machine.");
    const capture = new Capture(); capture.truncated = input.truncated === true;
    const boundedDescription = capture.text(description, 4096);
    const root = await this.tasks.session.root(BACKGROUND_CONTEXT);
    let conversation_id = input.conversation_id ?? root.id.toString();
    let model = input.model; let binding = input.binding;
    if (input.task_id !== null) {
      const task = await this.tasks.get(input.task_id);
      const actor = input.agent_id === null ? task : task.agents.find((agent) => agent.id === input.agent_id);
      if (actor === undefined) throw new Error("The feedback task agent is unavailable.");
      if (input.conversation_id !== null && actor.conversation_id !== input.conversation_id) throw new Error("Feedback conversation does not belong to this task.");
      conversation_id = actor.conversation_id; model = actor.model ?? task.model ?? model;
      if ("binding" in actor.worker) binding = actor.worker.binding;
    } else if (input.agent_id !== null) throw new Error("Choose a task for agent feedback.");
    const conversation = conversation_id === root.id.toString() ? root : await this.tasks.conversation(conversation_id);
    const page = await conversation.entries({ order: "descending" }, 40, undefined, BACKGROUND_CONTEXT);
    const context: FeedbackContext = { ...input, conversation_id, model, binding,
      draft: capture.text(input.draft), queued_inputs: input.queued_inputs.slice(0, 16).map((value) => capture.text(value, 1024)),
      client_errors: input.client_errors.slice(-8).map((value) => capture.text(value, 2048)) };
    if (input.queued_inputs.length > 16 || input.client_errors.length > 8) capture.truncated = true;
    const entries = page.items.map((entry) => diagnostic(entry, capture)).reverse().filter((entry) => entry.evidence.length > 0);
    const bundle: FeedbackBundle = { id: inputId ?? randomUUID(), created_at: Date.now(), description: boundedDescription, context,
      entries, older_entries: page.next !== undefined, truncated: capture.truncated,
      omissions: ["System instructions, auth/config/environment stores, hidden thinking and media bytes are excluded.",
        "Execution/file/unknown tool payloads are omitted; canonical entry and call IDs remain available.",
        "Known credential forms are redacted; private conversation prose may still contain sensitive user data."] };
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    await privateWrite(this.path(bundle.id), JSON.stringify(bundle));
    await privateWrite(join(this.directory, "latest"), bundle.id);
    return bundle;
  }

  path(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid feedback ID");
    return join(this.directory, `${id}.json`);
  }

  async read(id: string | null): Promise<FeedbackBundle> {
    const selected = id ?? await readFile(join(this.directory, "latest"), "utf8").catch((error: unknown) => {
      if (object(error) && error.code === "ENOENT") throw new Error("No private feedback has been captured."); throw error;
    });
    const value: unknown = JSON.parse(await readFile(this.path(selected), "utf8"));
    // Reuse the generated event validator so persisted files and the wire have one owned contract.
    const { validEvent } = await import("./protocol.js");
    const event = { version: 1, id: 0, event: { type: "feedback", bundle: value } };
    if (!validEvent(event)) throw new Error("The private feedback bundle is invalid.");
    if (event.event.type !== "feedback" || event.event.bundle.id !== selected) throw new Error("Feedback identity does not match its file.");
    return event.event.bundle;
  }
}
