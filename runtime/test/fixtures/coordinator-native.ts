import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { setTimeout } from "node:timers/promises";
import { createInterface } from "node:readline";

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
  socket.pipe(process.stdout);
  const gate = process.env.AGENT_TEST_HISTORY_GATE;
  const attachGate = process.env.AGENT_TEST_ATTACH_GATE;
  const interruptGate = process.env.AGENT_TEST_INTERRUPT_GATE;
  if (gate === undefined && attachGate === undefined && interruptGate === undefined) process.stdin.pipe(socket);
  else {
    let first = true;
    for await (const line of createInterface({ input: process.stdin })) {
      const command: unknown = JSON.parse(line);
      if (gate !== undefined && first && object(command) && command.type === "read_conversation" && command.cursor !== null) {
        writeFileSync(gate + ".entered", "An older native page is waiting at its transport boundary.");
        while (!existsSync(gate + ".release")) await setTimeout(10);
      }
      if (attachGate !== undefined && first && object(command) && command.type === "attach_conversation" && !existsSync(attachGate + ".entered")) {
        writeFileSync(attachGate + ".entered", "Observation has not yet been admitted.");
        while (!existsSync(attachGate + ".release")) await setTimeout(10);
      }
      if (interruptGate !== undefined && object(command) && command.type === "conversation_interrupt") {
        writeFileSync(interruptGate + ".entered", "The previous interrupt has not reached the coordinator.");
        while (!existsSync(interruptGate + ".release")) await setTimeout(10);
        if (existsSync(interruptGate + ".fail")) {
          socket.destroy(); process.stdin.destroy(); process.stdout.end(); break;
        }
      }
      first = false;
      socket.write(line + "\n");
    }
    socket.end();
  }
} else if (process.env.AGENT_TEST_NATIVE === "rex") {
  const host = process.env.AGENT_TEST_NODE_ID, path = process.env.AGENT_TEST_REX_STATE; assert.ok(host && path);
  const args = process.argv.slice(2); const call = args.indexOf("call");
  const method = args.includes("whoami") ? "whoami" : args.includes("hosts") ? "hosts" : args[call + 1]; assert.ok(method);
  const input: unknown = call < 0 ? {} : JSON.parse(args[call + 2] ?? "null"); assert.ok(object(input));
  appendFileSync(path + ".calls", JSON.stringify({ method, input }) + "\n");
  const saved = sessions(path); let result: unknown;
  if (method === "whoami") result = { host_id: host, instance_id: "33333333-3333-4333-8333-333333333333", rex_version: "synthetic" };
  else if (method === "hosts") result = { hosts: [] };
  else if (method === "session.create" || method === "session.new_window") {
    const creating = method === "session.create";
    const gate = process.env.AGENT_TEST_FEEDBACK_GATE;
    if (!creating && input.window_label === "Agent feedback" && gate !== undefined && existsSync(gate)) {
      writeFileSync(gate + ".entered", "waiting");
      while (existsSync(gate)) await setTimeout(10);
    }
    if (creating) assert.ok(Array.isArray(input.initial_windows));
    const window: unknown = creating && Array.isArray(input.initial_windows) ? input.initial_windows[0] : input;
    assert.ok(object(window) && object(window.layout) && object(window.layout.block) && object(window.layout.block.options));
    const options = window.layout.block.options; assert.ok(Array.isArray(options.command) && options.command.every((arg: unknown) => typeof arg === "string"));
    const session_id = creating ? `session:${randomUUID()}` : field(input, "session_id");
    if (!creating) assert.ok(saved.some((session) => session.session_id === session_id));
    const session: NativeSession = { session_id, window_id: `window:${randomUUID()}`, block_id: `block:${randomUUID()}`,
      label: field(input, creating ? "label" : "window_label"), cwd: field(options, "cwd"), command: options.command.map(String) };
    if (creating) saved.unshift(session); else saved.push(session);
    writeFileSync(path, JSON.stringify(saved));
    const created = { window_id: session.window_id, block_ids: [session.block_id], revision: 1 };
    result = creating ? { session_id: session.session_id, initial_windows: [created] } : created;
  } else if (method === "session.list") {
    const seen = new Set<string>();
    result = { sessions: saved.filter((session) => {
      if (seen.has(session.session_id)) return false; seen.add(session.session_id); return true;
    }).map((session) => ({ session_id: session.session_id, label: session.label })) };
  } else if (method === "session.view") {
    const session = saved.find((session) => session.session_id === input.session_id); assert.ok(session);
    result = { session_id: session.session_id, revision: 1, label: session.label,
      windows: saved.filter((window) => window.session_id === session.session_id).map((window) => ({ window_id: window.window_id, layers: [{ blocks: [
        { block_id: window.block_id, host_id: host, flavor: "com.superlogical.terminal.shell" },
      ] }] })) };
  } else if (method === "session.move") result = {};
  else if (method === "com.superlogical.terminal.process") result = { child: { pid: process.pid }, foreground: null, last_exit: null };
  else throw new Error(`Unexpected synthetic Rex operation: ${method}`);
  process.stdout.write(JSON.stringify(result));
}
