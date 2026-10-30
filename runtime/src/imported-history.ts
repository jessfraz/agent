import type { HistoryItem } from "./generated/HistoryItem.js";
import type { MessagePresentation } from "./generated/MessagePresentation.js";
import type { ToolStatus } from "./generated/ToolStatus.js";
import type { AgentAction } from "./generated/AgentAction.js";
import type { AgentState } from "./generated/AgentState.js";
import type { AgentActivityState } from "./generated/AgentActivityState.js";
import type { FileOperation } from "./generated/FileOperation.js";
import type { WebSearchAction } from "./generated/WebSearchAction.js";
import type { ToolDetailContent } from "./generated/ToolDetailContent.js";
import { bounded, content, field, label, list, milliseconds, object, string, type MessageContent } from "./message-presentation.js";

function exitCode(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647 ? value : null; }
function status(value: unknown): ToolStatus {
  switch (value) { case "inProgress": return "running"; case "completed": return "finished"; case "failed": return "failed";
    case "declined": return "declined"; case "interrupted": return "interrupted"; default: return "unknown"; }
}
function action(value: unknown): AgentAction | null {
  switch (value) { case "spawnAgent": return "spawn"; case "sendInput": return "send_input"; case "resumeAgent": return "resume";
    case "wait": return "wait"; case "closeAgent": return "close"; case "sendMessage": return "send_message";
    case "followupTask": return "followup"; case "interruptAgent": return "interrupt"; case "listAgents": return "list"; default: return null; }
}
function state(value: unknown): AgentState | null {
  switch (value) { case "pendingInit": return "pending"; case "running": return "running"; case "interrupted": return "interrupted";
    case "completed": return "completed"; case "errored": return "failed"; case "shutdown": return "shutdown"; case "notFound": return "not_found"; default: return null; }
}
function activity(value: unknown): AgentActivityState | null { return value === "started" || value === "interacted" || value === "interrupted" || value === "completed" ? value : null; }
function operation(value: unknown): FileOperation | null { return value === "add" || value === "delete" || value === "update" ? value : null; }
function webAction(value: unknown): WebSearchAction | null {
  switch (value) { case "search": return "search"; case "openPage": return "open_page"; case "findInPage": return "find_in_page"; case "other": return "other"; default: return null; }
}

/** Immutable evidence versions own distinct rows; their original native IDs remain untouched. */
export function historyToolId(entryId: string): string { return "history:" + entryId; }

/** Structured MCP output is evidence alongside its prose, never executable input. */
export function codexToolOutput(item: HistoryItem, data: unknown): Extract<ToolDetailContent, { type: "text" }> {
  const plain = content(field(data, "output")) || content(field(data, "result")) ||
    content(field(data, "contentItems")) || content(field(field(data, "error"), "message"));
  const output: Extract<ToolDetailContent, { type: "text" }> = { type: "text", text: plain, truncated: plain.length > 32_768 };
  if (item.kind !== "mcpToolCall") return output;
  const structured = field(field(data, "result"), "structuredContent");
  if (structured === undefined || structured === null) return output;
  const serialized = JSON.stringify(structured, null, 2);
  if (serialized === undefined) return output;
  // Keep both parts visible even when a large prose block consumes its budget.
  const structuredLimit = plain.length === 0 ? 32_768 : 16_384;
  const combined = [plain.length === 0 ? "" : bounded(plain, 16_384),
    "Structured result:\n" + bounded(serialized, structuredLimit)].filter((part) => part.length > 0).join("\n\n");
  return { type: "text", text: bounded(combined),
    truncated: plain.length > 16_384 || serialized.length > structuredLimit || combined.length > 32_768 };
}

function userReferences(data: unknown): string | undefined {
  const parts = list(field(data, "content"));
  if (!parts.some((part) => field(part, "type") === "skill" || field(part, "type") === "mention")) return undefined;
  return bounded(parts.map((part) => {
    const type = field(part, "type");
    if (type !== "skill" && type !== "mention") return content([part]);
    const name = label(field(part, "name"), type), path = label(field(part, "path"));
    return `Historical ${type === "skill" ? "skill reference" : "mention"}: ${name}${path.length === 0 ? "" : ` (${path})`}`;
  }).filter((part) => part.length > 0).join("\n"));
}

/** Codex is a source adapter into the same messages and renderer used by live Pi. */
export function codexMessage(item: HistoryItem, data: unknown, entryId: string): MessageContent {
  const tool = (name: string, presentation: MessagePresentation, text = "", explicitStatus = status(field(data, "status"))): MessageContent =>
    ({ role: "tool", text, tool: { call_id: historyToolId(entryId), name, status: explicitStatus }, presentation });
  switch (item.kind) {
    case "userMessage": return { role: "user", text: content(field(data, "content")) || item.text || (list(field(data, "content")).length > 0 ? "[Historical media attachment]" : "") };
    case "agentMessage": {
      const phase = field(data, "phase");
      return { role: phase === "commentary" ? "commentary" : phase === "partial_answer" ? "partial_answer" : phase === "final_answer" ? "final" : "assistant",
        text: bounded(string(field(data, "text")) ?? item.text) };
    }
    case "reasoning": return { role: "thinking", text: [content(field(data, "summary")), content(field(data, "content"))].filter((part) => part.trim().length > 0).join("\n") || item.text };
    case "commandExecution": {
      const command = string(field(data, "command"));
      return tool("exec", { type: "command", ...(command === null ? {} : { command: bounded(command, 1024) }), exit_code: exitCode(field(data, "exitCode")),
        duration_ms: milliseconds(field(data, "durationMs")) });
    }
    case "fileChange": return tool("edit", { type: "file_changes", changes: list(field(data, "changes")).slice(0, 16).map((change) =>
      ({ path: label(field(change, "path")), operation: operation(field(field(change, "kind"), "type")) })) }, list(field(data, "changes")).length > 16 ? "[More changes in retained original]" : "");
    case "functionCallOutput": return tool(label(field(data, "name"), "Tool output"), { type: "tool", namespace: string(field(data, "namespace")) });
    case "mcpToolCall": return tool(label(field(data, "tool"), "MCP tool"), { type: "tool", namespace: string(field(data, "server")) });
    case "dynamicToolCall": return tool(label(field(data, "tool"), "Dynamic tool"), { type: "tool", namespace: string(field(data, "namespace")) });
    case "collabAgentToolCall": {
      const states = field(data, "agentsStates");
      return tool(label(field(data, "tool"), "Agent operation"), { type: "agent_coordination", action: action(field(data, "tool")),
        sender_thread_id: string(field(data, "senderThreadId")), receiver_thread_ids: list(field(data, "receiverThreadIds")).flatMap((id) => typeof id === "string" ? [id] : []).slice(0, 16),
        agents: object(states) ? Object.entries(states).slice(0, 16).map(([id, agent]) => ({ thread_id: id, state: state(field(agent, "status")) })) : [] });
    }
    case "subAgentActivity": return { role: "tool", text: "", presentation: { type: "agent_activity", agent_path: label(field(data, "agentPath")),
      agent_thread_id: label(field(data, "agentThreadId")), state: activity(field(data, "kind")) } };
    case "webSearch": return tool("web_search", { type: "web_search", query: label(field(data, "query")), action: webAction(field(field(data, "action"), "type")) },
      label(field(field(data, "action"), "url")), "unknown");
    case "imageView": return { role: "tool", text: "", presentation: { type: "media", operation: "view", status: null, path: string(field(data, "path")) } };
    case "imageGeneration": return { role: "tool", text: "", presentation: { type: "media", operation: "generate", status: string(field(data, "status")), path: string(field(data, "savedPath")) } };
    case "sleep": return { role: "tool", text: "", presentation: { type: "sleep", duration_ms: milliseconds(field(data, "durationMs")) } };
    case "plan": return { role: item.role, text: string(field(data, "text")) ?? item.text, presentation: { type: "plan" } };
    case "enteredReviewMode": return { role: item.role, text: string(field(data, "review")) ?? item.text, presentation: { type: "review", stage: "started" } };
    case "exitedReviewMode": return { role: item.role, text: string(field(data, "review")) ?? item.text, presentation: { type: "review", stage: "finished" } };
    case "hookPrompt": return { role: "tool", text: "", presentation: { type: "hook_prompt" } };
    case "contextCompaction": return { role: "tool", text: "", presentation: { type: "compaction" } };
    default: return { role: "tool", text: "", presentation: { type: "unknown", kind: item.kind } };
  }
}

/** Display bodies are separate from the stable legacy formatter and indexed native excerpts. */
export function codexDisplayMessage(item: HistoryItem, data: unknown, entryId: string): MessageContent {
  const message = codexMessage(item, data, entryId);
  if (item.kind === "userMessage") return { ...message, text: userReferences(data) ?? message.text };
  switch (message.presentation?.type) {
    case "command": return { ...message, text: content(field(data, "aggregatedOutput")) };
    case "file_changes": return { ...message, text: bounded([...list(field(data, "changes")).slice(0, 16)
      .flatMap((change) => { const diff = string(field(change, "diff")); return diff === null ? [] : [bounded(diff)]; }), message.text].filter((part) => part.length > 0).join("\n")) };
    case "tool": return { ...message, text: codexToolOutput(item, data).text };
    default: return message;
  }
}
