import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validEvent } from "../src/protocol.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";

test("real Pi bridge gives signed-out chat the login command before starting Pi and rejects invalid commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-"));
  await chmod(directory, 0o700);
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"] });
  try {
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end([
      JSON.stringify({ version: 1, id: 1, command: { type: "status" } }),
      JSON.stringify({ version: 1, id: 2, command: { type: "invented" } }),
      JSON.stringify({ version: 1, id: 3, command: { type: "chat", input: "Hello", instructions: "",
        model: "fixture", cwd: "/workspace/example", hosts: [] } }),
      "invalid json", "",
    ].join("\n"));
    const code = await exited;
    assert.equal(code, 0, errors);
    const events: RuntimeEvent[] = output.trim().split("\n").map((line) => {
      const event: unknown = JSON.parse(line);
      assert.ok(validEvent(event));
      return event;
    });
    assert.deepEqual(events.filter((event) => event.id === 1), [
      { version: 1, id: 1, event: { type: "auth_status", status: { state: "signed_out" } } },
      { version: 1, id: 1, event: { type: "done" } },
    ]);
    assert.deepEqual(events.filter((event) => event.id === 3), [
      { version: 1, id: 3, event: { type: "failure", code: "authentication_required",
        message: "Not signed in to ChatGPT. Run agent login." } },
      { version: 1, id: 3, event: { type: "done" } },
    ]);
    assert.equal(events.filter((event) => event.event.type === "failure").length, 3);
    assert.equal(events.filter((event) => event.event.type === "done").length, 4);
    assert.deepEqual(await readdir(directory), ["auth.json"], "Signed-out chat must not open Pi conversation storage");
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
