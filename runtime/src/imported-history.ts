import type { HistoryItem } from "./generated/HistoryItem.js";
import type { MessagePresentation } from "./generated/MessagePresentation.js";
import type { ToolStatus } from "./generated/ToolStatus.js";
import type { AgentAction } from "./generated/AgentAction.js";
import type { AgentState } from "./generated/AgentState.js";
import type { AgentActivityState } from "./generated/AgentActivityState.js";
import type { FileOperation } from "./generated/FileOperation.js";
import type { WebSearchAction } from "./generated/WebSearchAction.js";
import { bounded, content, field, label, list, object, string, type MessageContent } from "./message-presentation.js";

function duration(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
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
    case "commandExecution": return tool("exec", { type: "command", exit_code: exitCode(field(data, "exitCode")),
      duration_ms: duration(field(data, "durationMs")) });
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
    case "sleep": return { role: "tool", text: "", presentation: { type: "sleep", duration_ms: duration(field(data, "durationMs")) } };
    case "plan": return { role: item.role, text: string(field(data, "text")) ?? item.text, presentation: { type: "plan" } };
    case "enteredReviewMode": return { role: item.role, text: string(field(data, "review")) ?? item.text, presentation: { type: "review", stage: "started" } };
    case "exitedReviewMode": return { role: item.role, text: string(field(data, "review")) ?? item.text, presentation: { type: "review", stage: "finished" } };
    case "hookPrompt": return { role: "tool", text: "", presentation: { type: "hook_prompt" } };
    case "contextCompaction": return { role: "tool", text: "", presentation: { type: "compaction" } };
    default: return { role: "tool", text: "", presentation: { type: "unknown", kind: item.kind } };
  }
}
