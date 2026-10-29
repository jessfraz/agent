import assert from "node:assert/strict";
import { test } from "node:test";
import { invalidHostReply, protocolLines, validEvent, validRequest } from "../src/protocol.js";
import type { MachineSnapshot } from "../src/generated/MachineSnapshot.js";
import type { RuntimeRequest } from "../src/generated/RuntimeRequest.js";

test("LF frames preserve Unicode and UTF-8 across every byte boundary, CRLF and EOF", async () => {
  const first = JSON.stringify({ text: "Line\u2028paragraph\u2029🐙日本語 café" });
  const last = JSON.stringify({ text: "EOF 🦀" });
  const wire = Buffer.from(`${first}\r\n\nbare\rcarriage\n${last}`);
  async function* input(chunks: Uint8Array[]) { yield* chunks; }
  const cases = [[wire], [...wire].map((byte) => Buffer.from([byte]))];
  for (let split = 0; split <= wire.length; split += 1) cases.push([wire.subarray(0, split), wire.subarray(split)]);
  for (const chunks of cases) {
    const frames: string[] = []; for await (const line of protocolLines(input(chunks))) frames.push(line);
    assert.deepEqual(frames, [first, "", "bare\rcarriage", last]);
  }
  const terminated: string[] = []; for await (const line of protocolLines(input([Buffer.from("one\r\n\n")]))) terminated.push(line);
  assert.deepEqual(terminated, ["one", ""]);
  const empty: string[] = []; for await (const line of protocolLines(input([]))) empty.push(line);
  assert.deepEqual(empty, []);
});

test("machine telemetry preserves legacy environment reads and validates native IPv4 samples", () => {
  assert.equal(validRequest({ version: 1, id: 1, command: { type: "environment" } }), true);
  const snapshot: MachineSnapshot = { observed_at_ms: 1000, os: "linux", architecture: "x86_64", logical_cpus: 8,
    memory_total_bytes: 32 * 1024 ** 3, memory_available_bytes: null, load_average: [1, 0.5, 0.25], tailscale_ip: "100.64.0.10" };
  const frame: RuntimeRequest = { version: 1, id: 1, command: { type: "host_reply", call_id: "machine-probe", result: { type: "machine_snapshot", snapshot } } };
  assert.equal(validRequest(frame), true);
  for (const tailscale_ip of ["not-an-address", "100.64.0.999", "::1"]) {
    assert.equal(validRequest({ ...frame, command: { type: "host_reply", call_id: "machine-probe", result: { type: "machine_snapshot", snapshot: { ...snapshot, tailscale_ip } } } }), false);
  }
});

test("generated protocol rejects out-of-range and lossy numeric values", () => {
  const frame = { version: 1, id: 0xffff_ffff, command: { type: "status" } };
  assert.equal(validRequest(frame), true);
  for (const id of [-1, 0x1_0000_0000, 1.5]) {
    assert.equal(validRequest({ ...frame, id }), false);
  }
  const connected = {
    version: 1, id: 1,
    event: { type: "auth_status", status: { state: "connected", expires_at: 1_800_000_000,
      account: { issuer: "https://issuer.example", subject: "synthetic-user", email: null } } },
  };
  assert.equal(validEvent(connected), true);
  for (const expires_at of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validEvent({ ...connected, event: { ...connected.event,
      status: { ...connected.event.status, expires_at } } }), false);
  }
  assert.equal(validRequest({ version: 1, id: 1, command: { type: "chat", input: "hello" } }), false);
});

test("malformed host replies require a valid transport identity and retain only schema diagnostics", () => {
  const frame = { version: 1, id: 7, command: { type: "host_reply", call_id: "fixture-call",
    result: { type: "process", exit_code: "private payload", stdout: "", stderr: "", truncated: false } } };
  assert.equal(validRequest(frame), false);
  const rejected = invalidHostReply(frame, 1); assert.ok(rejected);
  assert.equal(validRequest(rejected), true); assert.equal(rejected.id, 7); assert.equal(rejected.command.call_id, "fixture-call");
  assert.ok(rejected.command.result.type === "failed"); assert.match(rejected.command.result.message, /schema validation/);
  assert.equal(rejected.command.result.message.includes("private payload"), false);
  for (const invalid of [
    ...[-1, 0x1_0000_0000, 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ({ ...frame, id })),
    { ...frame, version: 2 }, { ...frame, command: { ...frame.command, call_id: 7 } },
    { ...frame, command: { type: "invented" } },
  ]) {
    assert.equal(validRequest(invalid), false);
    assert.equal(invalidHostReply(invalid, 1), undefined);
  }
});
