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
