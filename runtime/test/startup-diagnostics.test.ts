import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RuntimeRequest } from "../src/generated/RuntimeRequest.js";
import { validEvent } from "../src/protocol.js";
import { StartupDiagnostics } from "../src/startup-diagnostics.js";

async function records(state: string): Promise<unknown[]> {
  const text = await readFile(join(state, "diagnostics", "startup.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => {
    const record: unknown = JSON.parse(line);
    assert.ok(record !== null && typeof record === "object" && "time_ms" in record);
    assert.ok(typeof record.time_ms === "number" && Number.isSafeInteger(record.time_ms) && record.time_ms > 0);
    const normalized: { [key: string]: unknown } = { ...record, time_ms: 0 };
    if ("duration_ms" in record) {
      assert.ok(typeof record.duration_ms === "number" && Number.isSafeInteger(record.duration_ms) && record.duration_ms >= 0);
      normalized.duration_ms = 0;
    }
    return normalized;
  });
}

test("startup diagnostics retain fixed stages and nested native codes without serializing error content", async () => {
  const state = await mkdtemp(join(tmpdir(), "agent-startup-codes-"));
  const diagnostics = new StartupDiagnostics(state), database = new DatabaseSync(join(state, "probe.sqlite"));
  let original: Error | undefined;
  try {
    assert.equal(await diagnostics.run("storage_open", async () => {
      database.exec("CREATE TABLE present(id INTEGER PRIMARY KEY)"); return 17;
    }), 17);
    await assert.rejects(diagnostics.run("harness_recovery", async () => {
      try { database.exec("SELECT * FROM unavailable_startup_table"); }
      catch (cause) { original = new Error("Private SQL, path and token must remain private", { cause }); throw original; }
    }), (error: unknown) => { assert.equal(error, original); return true; });
    await assert.rejects(diagnostics.run("environment_configure", async () => {
      try { await readFile(join(state, "unavailable-private-config")); }
      catch (cause) { original = new Error("Private configuration and credentials must remain private", { cause }); throw original; }
    }), (error: unknown) => { assert.equal(error, original); return true; });
    assert.deepEqual(await records(state), [
      { version: 1, time_ms: 0, stage: "storage_open", kind: "begin" },
      { version: 1, time_ms: 0, stage: "storage_open", kind: "ready", duration_ms: 0 },
      { version: 1, time_ms: 0, stage: "harness_recovery", kind: "begin" },
      { version: 1, time_ms: 0, stage: "harness_recovery", kind: "failed", duration_ms: 0,
        causes: [{ kind: "error" }, { kind: "sqlite", code: 1 }], truncated: false },
      { version: 1, time_ms: 0, stage: "environment_configure", kind: "begin" },
      { version: 1, time_ms: 0, stage: "environment_configure", kind: "failed", duration_ms: 0,
        causes: [{ kind: "error" }, { kind: "os", code: -2 }], truncated: false },
    ]);
  } finally { database.close(); await rm(state, { recursive: true, force: true }); }
});

test("startup diagnostics bound nested causes and never copy arbitrary thrown values or codes", async () => {
  const state = await mkdtemp(join(tmpdir(), "agent-startup-causes-"));
  const diagnostics = new StartupDiagnostics(state);
  try {
    let original: unknown;
    try { await readFile(join(state, "unavailable")); } catch (error) { original = error; }
    for (let index = 0; index < 6; index++) original = new Error("Private nested cause " + index, { cause: original });
    await assert.rejects(diagnostics.run("application_recovery", async () => { throw original; }), (error: unknown) => error === original);
    const arbitrary = { code: "private-token-code", errcode: Infinity, errno: 2 ** 40, cause: "private-token-cause" };
    await assert.rejects(diagnostics.run("node_registration", async () => { throw arbitrary; }), (error: unknown) => error === arbitrary);
    assert.deepEqual(await records(state), [
      { version: 1, time_ms: 0, stage: "application_recovery", kind: "begin" },
      { version: 1, time_ms: 0, stage: "application_recovery", kind: "failed", duration_ms: 0,
        causes: Array.from({ length: 4 }, () => ({ kind: "error" })), truncated: true },
      { version: 1, time_ms: 0, stage: "node_registration", kind: "begin" },
      { version: 1, time_ms: 0, stage: "node_registration", kind: "failed", duration_ms: 0,
        causes: [{ kind: "unknown" }, { kind: "unknown" }], truncated: false },
    ]);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("startup diagnostics bound retained bytes and restore owner-only file and directory permissions", async () => {
  const state = await mkdtemp(join(tmpdir(), "agent-startup-bounds-"));
  const diagnostics = new StartupDiagnostics(state), directory = join(state, "diagnostics"), path = join(directory, "startup.jsonl");
  try {
    await diagnostics.run("storage_open", async () => {});
    await writeFile(path, Buffer.alloc(70 * 1024, 120));
    await chmod(path, 0o666); await chmod(directory, 0o777);
    await diagnostics.run("storage_open", async () => {});
    assert.ok((await stat(path)).size <= 64 * 1024);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await records(state), [
      { version: 1, time_ms: 0, stage: "storage_open", kind: "begin" },
      { version: 1, time_ms: 0, stage: "storage_open", kind: "ready", duration_ms: 0 },
    ]);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("a real diagnostics filesystem failure cannot mask the startup result or original failure", async () => {
  const state = await mkdtemp(join(tmpdir(), "agent-startup-unavailable-"));
  const diagnostics = new StartupDiagnostics(state);
  try {
    await writeFile(join(state, "diagnostics"), "A file prevents diagnostic directory creation");
    assert.equal(await diagnostics.run("storage_open", async () => 23), 23);
    let original: unknown;
    await assert.rejects(diagnostics.run("harness_recovery", async () => {
      try { await readFile(join(state, "unavailable")); } catch (error) { original = error; throw error; }
    }), (error: unknown) => { assert.ok(original); assert.equal(error, original); return true; });
    assert.equal(await readFile(join(state, "diagnostics"), "utf8"), "A file prevents diagnostic directory creation");
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("the real bridge records a corrupt SQLite startup stage without changing its protocol", { timeout: 10_000 }, async (t) => {
  const state = await mkdtemp(join(tmpdir(), "agent-startup-bridge-"));
  await writeFile(join(state, "session.sqlite"), "This is a corrupt synthetic SQLite database".repeat(100));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), state],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  t.signal.addEventListener("abort", () => child.kill(), { once: true });
  try {
    const request: RuntimeRequest = { version: 1, id: 1, command: { type: "list_tasks" } };
    child.stdin.end(JSON.stringify(request) + "\n");
    assert.equal(await exited, 0, errors);
    const events = output.trim().split("\n").map((line) => {
      const event: unknown = JSON.parse(line); assert.ok(validEvent(event)); return event;
    });
    assert.deepEqual(events.map((event) => event.event.type), ["failure", "done"]);
    assert.deepEqual(await records(state), [
      { version: 1, time_ms: 0, stage: "storage_open", kind: "begin" },
      { version: 1, time_ms: 0, stage: "storage_open", kind: "failed", duration_ms: 0,
        causes: [{ kind: "sqlite", code: 26 }], truncated: false },
    ]);
  } finally { child.kill(); await exited.catch(() => {}); await rm(state, { recursive: true, force: true }); }
});
