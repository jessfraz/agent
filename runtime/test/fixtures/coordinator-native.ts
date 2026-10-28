import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";

export type NativeSession = { session_id: string; window_id: string; block_id: string; label: string; command: string[]; cwd: string };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function field(value: Record<string, unknown>, key: string): string { const item = value[key]; assert.equal(typeof item, "string"); return String(item); }
export function sessions(path: string): NativeSession[] {
  const values: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  assert.ok(Array.isArray(values));
  return values.map((value: unknown) => {
    assert.ok(object(value) && Array.isArray(value.command) && value.command.every((arg: unknown) => typeof arg === "string"));
    return { session_id: field(value, "session_id"), window_id: field(value, "window_id"), block_id: field(value, "block_id"),
      label: field(value, "label"), cwd: field(value, "cwd"), command: value.command.map(String) };
  });
}

if (process.env.AGENT_TEST_NATIVE === "ssh") {
  const path = process.env.AGENT_TEST_COORDINATOR_SOCKET; assert.ok(path);
  const socket = createConnection(path);
  socket.on("error", () => process.exitCode = 1);
  process.stdin.pipe(socket); socket.pipe(process.stdout);
} else if (process.env.AGENT_TEST_NATIVE === "rex") {
  const host = process.env.AGENT_TEST_NODE_ID, path = process.env.AGENT_TEST_REX_STATE; assert.ok(host && path);
  const args = process.argv.slice(2); const call = args.indexOf("call");
  const method = args.includes("whoami") ? "whoami" : args.includes("hosts") ? "hosts" : args[call + 1]; assert.ok(method);
  const input: unknown = call < 0 ? {} : JSON.parse(args[call + 2] ?? "null"); assert.ok(object(input));
  appendFileSync(path + ".calls", JSON.stringify({ method, input }) + "\n");
  const saved = sessions(path); let result: unknown;
  if (method === "whoami") result = { host_id: host, instance_id: "33333333-3333-4333-8333-333333333333", rex_version: "synthetic" };
  else if (method === "hosts") result = { hosts: [] };
  else if (method === "session.create") {
    assert.ok(Array.isArray(input.initial_windows)); const window: unknown = input.initial_windows[0];
    assert.ok(object(window) && object(window.layout) && object(window.layout.block) && object(window.layout.block.options));
    const options = window.layout.block.options; assert.ok(Array.isArray(options.command) && options.command.every((arg: unknown) => typeof arg === "string"));
    const session: NativeSession = { session_id: `session:${randomUUID()}`, window_id: `window:${randomUUID()}`, block_id: `block:${randomUUID()}`,
      label: field(input, "label"), cwd: field(options, "cwd"), command: options.command.map(String) };
    saved.unshift(session); writeFileSync(path, JSON.stringify(saved));
    result = { session_id: session.session_id, initial_windows: [{ window_id: session.window_id, block_ids: [session.block_id], revision: 1 }] };
  } else if (method === "session.list") result = { sessions: saved.map((session) => ({ session_id: session.session_id, label: session.label })) };
  else if (method === "session.view") {
    const session = saved.find((session) => session.session_id === input.session_id); assert.ok(session);
    result = { session_id: session.session_id, revision: 1, label: session.label, windows: [{ window_id: session.window_id, layers: [{ blocks: [
      { block_id: session.block_id, host_id: host, flavor: "com.superlogical.terminal.shell" },
    ] }] }] };
  } else if (method === "session.move") result = {};
  else if (method === "com.superlogical.terminal.process") result = { child: { pid: process.pid }, foreground: null, last_exit: null };
  else throw new Error(`Unexpected synthetic Rex operation: ${method}`);
  process.stdout.write(JSON.stringify(result));
}
