import type { HistoryMessage } from "./generated/HistoryMessage.js";
import type { MessagePresentation } from "./generated/MessagePresentation.js";
import type { AgentAction } from "./generated/AgentAction.js";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentStatePresentation } from "./generated/AgentStatePresentation.js";
import { validEvent, validRequest } from "./protocol.js";

export type MessageContent = Pick<HistoryMessage, "role" | "text" | "tool" | "presentation">;
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function field(value: unknown, key: string): unknown { return object(value) ? value[key] : undefined; }
export function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function bounded(value: string, maximum = 32_768, suffix = "\n[Excerpt; full original retained]"): string {
  if (value.length <= maximum) return value;
  let end = maximum; const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end) + suffix;
}
export function outputPreview(value: string): string {
  const maximum = 32_768, suffix = "\n[Output preview truncated]";
  return value.length <= maximum ? value : bounded(value, maximum - suffix.length, suffix);
}
export function label(value: unknown, fallback = ""): string { return bounded(string(value) ?? fallback, 1024); }
export function content(value: unknown): string {
  if (typeof value === "string") return bounded(value);
  const parts = Array.isArray(value) ? value : list(field(value, "content"));
  return bounded(parts.flatMap((part) => { const text = typeof part === "string" ? part : field(part, "text"); return typeof text === "string" ? [bounded(text)] : []; }).join("\n"));
}
const actions: Record<AgentAction, string> = { spawn: "Spawn agent", send_input: "Send agent input", resume: "Resume agent", wait: "Wait for agents",
  close: "Close agent", send_message: "Message agent", followup: "Follow up with agent", interrupt: "Interrupt agent", list: "List agents", report: "Agent report" };

/** Legacy flattened text stays stable; display clients render typed headings separately. */
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

export function milliseconds(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function quoted(value: string): string { return /^[\w./:=+,-]+$/u.test(value) ? value : "'" + value.replace(/'/gu, "'\\''") + "'"; }
export function commandPresentation(program: string, args: readonly string[]): Extract<MessagePresentation, { type: "command" }> {
  return { type: "command", command: bounded([quoted(program), ...args.map(quoted)].join(" "), 1024), exit_code: null, duration_ms: null };
}
function coordination(call: Pick<ToolCall, "name" | "arguments">): AgentAction | null | undefined {
  switch (call.name) {
    case "spawn_agent": return "spawn";
    case "continue_agent": return field(call.arguments, "mode") === "follow_up" ? "followup" : "send_input";
    case "read_agents": return "list";
    case "wait_agents": return "wait";
    case "report_result": return "report";
    case "delegate_task": {
      if (typeof field(call.arguments, "task_id") === "string" || typeof field(call.arguments, "conversation_id") === "string") {
        return field(call.arguments, "mode") === "follow_up" ? "followup" : "send_input";
      }
      return field(call.arguments, "new_task") === true ? "spawn" : null;
    }
    default: return undefined;
  }
}

/** Only declared, human-readable fields become headings; arbitrary inputs remain lazy. */
export function piToolPresentation(call: ToolCall, sender: string): MessagePresentation {
  if (call.name === "exec") {
    const program = field(call.arguments, "program"), args = field(call.arguments, "args");
    return typeof program === "string" && Array.isArray(args) && args.every((arg: unknown) => typeof arg === "string")
      ? commandPresentation(program, args) : { type: "command", exit_code: null, duration_ms: null };
  }
  const action = coordination(call);
  if (action !== undefined) return { type: "agent_coordination", action, sender_thread_id: sender, receiver_thread_ids: [], agents: [] };
  if (call.name === "write_file" || call.name === "edit_file") {
    const path = string(field(call.arguments, "path"));
    return { type: "file_changes", changes: path === null ? [] : [{ path: bounded(path, 1024), operation: call.name === "edit_file" ? "update" : null }] };
  }
  if (call.name === "read_attachment") return { type: "media", operation: "attachment", status: null, path: null };
  return { type: "tool", namespace: null };
}
function decodedOutput(result: ToolResultMessage): unknown {
  const first = result.content[0];
  if (first?.type !== "text") return undefined;
  try { const value: unknown = JSON.parse(first.text); return value; } catch { return undefined; }
}
function hostResult(result: ToolResultMessage) {
  const frame: unknown = { version: 1, id: 0, command: { type: "host_reply", call_id: result.toolCallId, result: decodedOutput(result) } };
  return validRequest(frame) && frame.command.type === "host_reply" ? frame.command.result : undefined;
}
function savedPresentation(result: ToolResultMessage): MessageContent | undefined {
  // Pi's UI-only details retain the same Rust-owned message fields, not arbitrary arguments.
  if (!object(result.details)) return undefined;
  const frame: unknown = { version: 1, id: 0, event: { type: "message", message: { ...result.details, entry_id: "0",
    continuation: false, final_chunk: true } } };
  const message = validEvent(frame) && frame.event.type === "message" ? frame.event.message : undefined;
  return message?.role === "tool" && (message.presentation?.type === "command" || message.presentation?.type === "agent_coordination") ? message : undefined;
}

/** The same receipt metadata is persisted by real tools and read by live/reopened views. */
export function agentPresentation(call: Pick<ToolCall, "name" | "arguments">, sender: string, output: unknown, targetAgentId?: string): Extract<MessagePresentation, { type: "agent_coordination" }> {
  let agents: AgentStatePresentation[];
  if (call.name === "delegate_task") agents = agentStates([output], false);
  else if (call.name === "spawn_agent" || call.name === "continue_agent") {
    const id = targetAgentId ?? field(call.arguments, "agent_id"), title = field(call.arguments, "title");
    const targets = list(field(output, "agents")).filter((agent) =>
      typeof id === "string" ? field(agent, "id") === id : typeof title === "string" && field(agent, "title") === title);
    agents = targets.length === 1 ? agentStates(targets, false) : [];
  } else if (call.name === "report_result") {
    agents = agentStates(list(field(output, "agents")).filter((agent) => field(agent, "conversation_id") === sender));
  } else agents = agentStates(Array.isArray(output) ? output : field(output, "agents"));
  const receivers = call.name === "read_agents" || call.name === "wait_agents" ? [] : agents.map((agent) => agent.thread_id);
  return { type: "agent_coordination", action: coordination(call) ?? null, sender_thread_id: sender, receiver_thread_ids: receivers, agents };
}
function agentStates(value: unknown, includeState = true): AgentStatePresentation[] {
  return list(value).slice(0, 16).flatMap((agent) => {
    const id = string(field(agent, "conversation_id"));
    if (id === null) return [];
    const stored = field(field(agent, "state"), "state");
    const state: AgentStatePresentation["state"] = !includeState ? null : stored === "done" ? "completed" : stored === "failed" ? "failed" : null;
    const name = string(field(agent, "title"))?.trim();
    return [{ thread_id: id, ...(name ? { name: bounded(name, 1024) } : {}), state }];
  });
}

/** Native result identity/status/timing are authoritative; bodies contain no heading prefixes. */
export function piToolResult(result: ToolResultMessage, sender: string, call?: ToolCall): MessageContent {
  const previous = call === undefined ? undefined : piToolPresentation(call, sender);
  let presentation: MessagePresentation = previous ?? { type: "tool", namespace: null }, text = content(result.content);
  const action = coordination({ name: result.toolName, arguments: {} });
  if (result.toolName === "exec") {
    const native = hostResult(result);
    const saved = savedPresentation(result), metadata = saved?.presentation?.type === "command" ? saved.presentation : undefined;
    const command = metadata?.command ?? (previous?.type === "command" ? previous.command : undefined);
    presentation = { type: "command", ...(command === undefined ? {} : { command }),
      exit_code: native?.type === "process" ? native.exit_code : metadata?.exit_code ?? null, duration_ms: milliseconds(result.durationMs) };
    text = saved === undefined ? (native?.type === "process" ? bounded([native.stdout, native.stderr].filter((part) => part.length > 0).join("\n"))
      : native?.type === "failed" ? bounded(native.message) : content(result.content)) : outputPreview(saved.text);
  } else if (action !== undefined) {
    // Delegation returns the parent TaskRecord, including unrelated old children.
    // Input delivery is not completion of that task or any of those children.
    const saved = savedPresentation(result)?.presentation;
    presentation = saved?.type === "agent_coordination" ? saved : agentPresentation(call ?? { name: result.toolName, arguments: {} }, sender, decodedOutput(result));
    text = result.isError ? content(result.content) : "";
  } else if (result.toolName === "write_file" || result.toolName === "edit_file") {
    presentation = previous?.type === "file_changes" ? previous : { type: "file_changes", changes: [] };
    const native = hostResult(result);
    text = native?.type === "failed" ? bounded(native.message) : result.isError ? content(result.content) : "";
  } else if (result.toolName === "read_attachment") {
    presentation = { type: "media", operation: "attachment", status: null, path: null };
    text = content(result.content);
  }
  return { role: "tool", text, presentation, tool: { call_id: result.toolCallId, name: result.toolName, status: result.isError ? "failed" : "finished" } };
}
