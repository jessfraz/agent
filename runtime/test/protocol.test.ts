import assert from "node:assert/strict";
import { test } from "node:test";
import { validEvent, validRequest } from "../src/protocol.js";

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
