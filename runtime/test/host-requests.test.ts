import assert from "node:assert/strict";
import { test } from "node:test";
import { HostRequests } from "../src/tools.js";
import type { HostCommand } from "../src/generated/HostCommand.js";

test("interrupt fences new host calls until owned effects settle and the next turn resumes", async () => {
  const calls: { request: number; call: string }[] = [];
  const cancelled: string[] = [];
  const requests = new HostRequests((request, call) => calls.push({ request, call }),
    (_request, call) => cancelled.push(call));
  const operation: HostCommand = { type: "exec", program: "/bin/sleep", args: ["60"], cwd: "/", timeout_seconds: 90 };
  let settled = false;
  const pending = requests.call(7, operation).then((result) => { settled = true; return result; });
  const admitted = calls[0]; assert.ok(admitted);
  requests.cancelRequest(7); requests.cancelRequest(7);
  assert.deepEqual(cancelled, [admitted.call]);
  await assert.rejects(requests.call(7, operation), /interrupted before/);
  assert.equal(calls.length, 1, "An interrupted turn must not start another effect");
  assert.equal(settled, false, "Cancellation keeps ownership until the executor confirms its result");
  assert.equal(requests.reply(8, admitted.call, { type: "written" }), false);
  assert.equal(requests.reply(7, admitted.call, { type: "process", exit_code: 143, stdout: "", stderr: "", truncated: false }), true);
  assert.equal((await pending).type, "process");
  requests.resumeRequest(7);
  const next = requests.call(7, operation);
  const correction = calls[1]; assert.ok(correction);
  requests.cancelRequest(7);
  assert.deepEqual(cancelled, [admitted.call, correction.call]);
  requests.reply(7, correction.call, { type: "written" }); await next;
  requests.finish(7);
  const independent = requests.call(9, operation);
  const other = calls[2]; assert.ok(other);
  requests.reply(9, other.call, { type: "written" }); await independent;
});

test("interrupt immediately releases embedding callers but preserves independent work and ignores late replies", async () => {
  const calls: { request: number; call: string }[] = [], cancelled: string[] = [];
  const requests = new HostRequests((request, call) => calls.push({ request, call }),
    (_request, call) => cancelled.push(call));
  const embedding: HostCommand = { type: "embed", purpose: "query", texts: ["retained context"] };
  const held = requests.call(7, embedding);
  let result: "pending" | "rejected" = "pending";
  const rejected = held.catch((error: unknown) => {
    assert.ok(error instanceof Error); result = "rejected";
  });
  const independent = requests.call(8, embedding);
  const first = calls[0], second = calls[1]; assert.ok(first && second);
  requests.cancelRequest(7); requests.cancelRequest(7);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result, "rejected", "Read-only cancellation must release the caller without waiting for a host reply");
    await rejected;
    assert.deepEqual(cancelled, [first.call]);
    assert.equal(requests.reply(7, first.call, { type: "failed", message: "Late cancellation receipt" }), false);
    assert.equal(requests.reply(8, second.call, { type: "failed", message: "Independent reply" }), true);
    assert.deepEqual(await independent, { type: "failed", message: "Independent reply" });
    await assert.rejects(requests.call(7, embedding), /interrupted before/);
    requests.resumeRequest(7);
    const next = requests.call(7, embedding); const third = calls[2]; assert.ok(third);
    requests.reply(7, third.call, { type: "failed", message: "New turn" }); await next;
  } finally {
    requests.reply(7, first.call, { type: "failed", message: "Cleanup" });
    requests.reply(8, second.call, { type: "failed", message: "Cleanup" });
    requests.finish(7); requests.finish(8);
    await rejected;
  }
});
