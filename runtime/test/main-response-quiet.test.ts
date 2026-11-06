import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DEFAULT_MODEL } from "../src/models.js";
import { history } from "../src/transcript.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";

async function openBridge(directory: string) {
  const queue = join(directory, "responses.json");
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const frames: RuntimeEvent[] = [], changes = new Set<() => void>(); let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  const events = (id: number) => frames.filter((frame) => frame.id === id).map((frame) => frame.event);
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const wait = (id: number, type: RuntimeEventKind["type"]) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { changes.delete(check); reject(new Error(`Missing ${id}/${type}: ${errors}`)); }, 5_000);
    const check = () => { if (events(id).some((event) => event.type === type)) { clearTimeout(timer); changes.delete(check); resolve(); } };
    changes.add(check); check();
  });
  const reader = (async () => { for await (const line of protocolLines(child.stdout)) {
    const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame); for (const check of changes) check();
    if (frame.event.type !== "host_call") continue;
    let command = frame.event.command; while (command.type === "on_node") command = command.command;
    const result: HostResult = command.type === "reload_guidance" ? { type: "shared_guidance", global: { text: "Keep routine receipts quiet.", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] }
      : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
      : { type: "failed", message: "Synthetic host effects disabled" };
    send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
  } })(); void reader.catch(() => {});
  return { frames, events, send, wait,
    async close() { child.stdin.end(); try { assert.equal(await closed, 0, errors); await reader; } finally { child.kill(); await closed; await reader.catch(() => {}); } },
    async abort() { child.kill(); await closed; await reader.catch(() => {}); },
  };
}
function written(events: RuntimeEventKind[]): string[] {
  return events.flatMap((event) => event.type === "answer" ? [event.text]
    : event.type === "message" && ["assistant", "commentary", "final", "notice"].includes(event.message.role) ? [event.message.text]
    : event.type === "history" ? event.messages.filter((row) => ["assistant", "commentary", "final", "notice"].includes(row.role)).map((row) => row.text) : []).filter((text) => text.trim());
}

for (const first of ["retry", "reconnect"]) test(`legacy explicit no-reply intent remains unknown and quiet through ${first}, reopen and the other recovery path`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-legacy-quiet-")), queue = join(directory, "responses.json");
  await writeFile(queue, "{}");
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const open = async () => Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  let answer: string; const seeded = await open();
  try {
    const root = await seeded.root(BACKGROUND_CONTEXT); await root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    // This really predates the new reply policy. No marker or claimed intent is
    // manufactured from its content, current client, model or tool metadata.
    faux.setResponses([fauxAssistantMessage("")]);
    const result = await (await root.submit({ type: "input", requestId: "quiet", content: "Record this silently. Do not post any reply or completion receipt." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.ok(result.type === "input" && result.status === "done"); answer = result.answer.toString();
  } finally { await seeded.close(BACKGROUND_CONTEXT); }
  try {
    for (const mode of [first, first === "retry" ? "reconnect" : "retry", "reconnect"]) {
      const bridge = await openBridge(directory);
      try {
        if (mode === "retry") { bridge.send(1, { type: "main_input", input_id: "quiet", input: "A retry must retain the saved original.", mode: "steer" }); await bridge.wait(1, "done"); }
        else { bridge.send(1, { type: "observe_main", input_ids: ["quiet"] }); await bridge.wait(1, "worker_idle"); }
        assert.deepEqual(written(bridge.events(1)), [], "Unknown legacy silence must not acquire a diagnostic or completion receipt");
        if (mode !== "retry") { bridge.send(1, { type: "detach_main" }); await bridge.wait(1, "done"); }
        await bridge.close();
      } finally { await bridge.abort(); }
      const reopened = await open();
      try {
        const root = await reopened.root(BACKGROUND_CONTEXT), original = await root.commit((tx) => tx.submissionByRequest(root.id, "quiet"), BACKGROUND_CONTEXT);
        assert.ok(original?.type === "input" && original.status === "done"); assert.equal(original.answer.toString(), answer);
        const rows = (await history(root, null, reopened)).flatMap((event) => event.messages);
        assert.equal(rows.some((row) => ["assistant", "commentary", "final", "notice"].includes(row.role) && row.text.trim()), false);
      } finally { await reopened.close(BACKGROUND_CONTEXT); }
    }
    await assert.rejects(readFile(queue + ".requests"), { code: "ENOENT" }); assert.equal(faux.state.callCount, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("explicit native quiet completion survives retry and reconnect without suppressing a later direct question", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-native-quiet-")), queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({ "quiet-request": [{ tool: "finish_without_reply", args: {} }], "later-direct-question": [{ text: "Two plus two is four." }] }));
  let bridge = await openBridge(directory);
  try {
    const host = "11111111-1111-4111-8111-111111111111";
    bridge.send(10, { type: "configure_coordinator", bootstrap: { node: { host_id: host, name: "fixture", home_directory: "/tmp", agent_program: "/fixture/agent", rex_server: null, coordinator: null,
      launch: { model: null, state_dir: null, runtime: null, config: null, instructions: null } }, settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } }); await bridge.wait(10, "done");
    bridge.send(11, { type: "set_connected_nodes", host_ids: [host] }); await bridge.wait(11, "done");
    bridge.send(100, { type: "observe_main", input_ids: [] }); await bridge.wait(100, "worker_idle");
    bridge.send(1, { type: "main_input", input_id: "quiet", input: "quiet-request: Record this silently. Do not post any reply or completion receipt.", mode: "steer" }); await bridge.wait(1, "done");
    assert.deepEqual(written(bridge.events(1)), [], "A real native quiet decision must not become a diagnostic");
    bridge.send(2, { type: "main_input", input_id: "quiet", input: "Retry the same saved request.", mode: "steer" }); await bridge.wait(2, "done");
    assert.deepEqual(written(bridge.events(2)), []);
    bridge.send(3, { type: "main_input", input_id: "question", input: "later-direct-question: What is two plus two?", mode: "steer" }); await bridge.wait(3, "done");
    assert.deepEqual(written(bridge.events(3)), ["Two plus two is four."], "Quietness belongs to its native generation, not a sticky chat mode");
    bridge.send(100, { type: "detach_main" }); await bridge.wait(100, "done"); await bridge.close();
    bridge = await openBridge(directory);
    bridge.send(4, { type: "observe_main", input_ids: ["quiet", "question"] }); await bridge.wait(4, "worker_idle");
    assert.deepEqual(written(bridge.events(4)), ["Two plus two is four."], "Reopen preserves silence and the real later answer without replay");
    bridge.send(4, { type: "detach_main" }); await bridge.wait(4, "done"); await bridge.close();
    const requests = (await readFile(queue + ".requests", "utf8")).trim().split("\n");
    assert.equal(requests.length, 2, "Native quiet termination must not need another inference or synthesize a receipt");
  } finally { await bridge.abort(); await rm(directory, { recursive: true, force: true }); }
});
