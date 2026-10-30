import type { HistoryMessage } from "./generated/HistoryMessage.js";
import type { MessagePresentation } from "./generated/MessagePresentation.js";
import type { AgentAction } from "./generated/AgentAction.js";

export type MessageContent = Pick<HistoryMessage, "role" | "text" | "tool" | "presentation">;
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function field(value: unknown, key: string): unknown { return object(value) ? value[key] : undefined; }
export function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function bounded(value: string, maximum = 32_768): string {
  if (value.length <= maximum) return value;
  let end = maximum; const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end) + "\n[Excerpt; full original retained]";
}
export function label(value: unknown, fallback = ""): string { return bounded(string(value) ?? fallback, 1024); }
export function content(value: unknown): string {
  if (typeof value === "string") return bounded(value);
  const parts = Array.isArray(value) ? value : list(field(value, "content"));
  return bounded(parts.flatMap((part) => { const text = typeof part === "string" ? part : field(part, "text"); return typeof text === "string" ? [bounded(text)] : []; }).join("\n"));
}
const actions: Record<AgentAction, string> = { spawn: "Spawn agent", send_input: "Send agent input", resume: "Resume agent", wait: "Wait for agents",
  close: "Close agent", send_message: "Message agent", followup: "Follow up with agent", interrupt: "Interrupt agent", list: "List agents", report: "Agent report" };

/** Live Pi and retained-history adapters share this formatter and canonical metadata. */
export function renderMessage(message: MessageContent): string {
  const p = message.presentation;
  const status = message.tool?.status === "unknown" ? "status unavailable" : message.tool?.status;
  const outcome = status === undefined ? "" : " · " + status;
  let title: string;
  if (p === undefined) return message.text;
  switch (p.type) {
    case "command": title = (message.tool?.name ?? "Command") + (status === "running" || status === undefined ? "" : " " + status) +
      (p.exit_code === null ? "" : " · exit " + p.exit_code) + (p.duration_ms === null ? "" : " · " + p.duration_ms + " ms"); break;
    case "file_changes": title = "File changes: " + p.changes.map((change) => change.path).join(", ") + "\n" + outcome.replace(/^ · /u, "") + "\n" + p.changes.map((change) => (change.operation ?? "change") + " " + change.path).join("\n"); break;
    case "tool": title = (p.namespace === null ? "" : p.namespace + ".") + (message.tool?.name ?? "Tool") + outcome; break;
    case "agent_coordination": title = (p.action === null ? "Agent operation" : actions[p.action]) + "\n" + outcome.replace(/^ · /u, "") + "\n" +
      (p.agents.map((agent) => agent.thread_id + " · " + (agent.state ?? "state unavailable")).join("\n") || p.receiver_thread_ids.join("\n")); break;
    case "agent_activity": title = "Agent " + (p.agent_path || p.agent_thread_id || "activity") + " · " + (p.state ?? "activity unavailable"); break;
    case "web_search": title = (p.action === "open_page" ? "Open page" : p.action === "find_in_page" ? "Find in page" : "Web search") + (p.query ? " · " + p.query : ""); break;
    case "media": title = (p.operation === "generate" ? "Image generation" : p.operation === "view" ? "Image view" : "Media attachment") +
      (p.status === null ? "" : " · " + p.status) + (p.path === null ? "" : " · " + p.path); break;
    case "sleep": title = "Sleep" + (p.duration_ms === null ? "" : " · " + p.duration_ms + " ms"); break;
    case "plan": title = "Plan"; break;
    case "review": title = "Review " + p.stage; break;
    case "hook_prompt": title = "Historical hook prompt · inert"; break;
    case "compaction": title = "Context compacted"; break;
    case "unknown": title = "Unknown history item · " + p.kind; break;
    case "unavailable": title = "Historical " + p.kind + " · original unavailable"; break;
  }
  return bounded(title.trimEnd() + (message.text.trim().length === 0 ? "" : "\n" + message.text));
}

/** Execution inputs stay in the shared, lazy tool-details reader. */
export function piToolPresentation(name: string): MessagePresentation | undefined {
  if (name === "exec") return { type: "command", exit_code: null, duration_ms: null };
  const action: AgentAction | undefined = name === "spawn_agent" || name === "delegate_task" ? "spawn" : name === "continue_task" ? "send_input"
    : name === "report_result" ? "report" : undefined;
  if (action !== undefined) return { type: "agent_coordination", action, sender_thread_id: null, receiver_thread_ids: [], agents: [] };
  if (name === "edit") return { type: "file_changes", changes: [] };
  return undefined;
}
