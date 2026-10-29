import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "../src/models.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { HostResult } from "../src/generated/HostResult.js";

test("native main observation survives idle, correlates notices, streams text and rejects stopped queued input on reconnect", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-native-main-")), queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({
    "publish-native": [{ tool: "notify", args: { keys: [], text: "A useful durable notice." } }, { text: "Published the update." }],
    "stop-native": [{ tool: "exec", args: { program: "held", args: [] } }],
    "never-run-native": [{ text: "Must never run" }],
  }));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const frames: RuntimeEvent[] = [], changes = new Set<() => void>();
  let errors = "", held: { request: number; call: string } | undefined;
  child.stderr.setEncoding("utf8").on("data", (text: string) => { errors += text; });
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const wait = (id: number, predicate: (event: RuntimeEventKind) => boolean): Promise<RuntimeEventKind> => new Promise((resolve) => {
    const check = () => { const frame = frames.find((frame) => frame.id === id && predicate(frame.event)); if (frame !== undefined) { changes.delete(check); resolve(frame.event); } };
    changes.add(check); check();
  });
  const done = (id: number) => wait(id, (event) => event.type === "done");
  const events = (id: number) => frames.filter((frame) => frame.id === id).map((frame) => frame.event);
  const reader = (async () => {
    for await (const line of protocolLines(child.stdout)) {
      const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame);
      for (const check of changes) check();
      if (frame.event.type === "host_cancel" && held?.call === frame.event.call_id) {
        send(held.request, { type: "host_reply", call_id: held.call, result: { type: "process", exit_code: 143, stdout: "", stderr: "cancelled", truncated: false } });
      }
      if (frame.event.type !== "host_call") continue;
      let command = frame.event.command; while (command.type === "on_node") command = command.command;
      if (command.type === "exec") { held = { request: frame.id, call: frame.event.call_id }; continue; }
      const result: HostResult = command.type === "reload_guidance" ? { type: "shared_guidance", global: { text: "", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] }
        : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
        : { type: "failed", message: "Synthetic retrieval disabled" };
      send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
    }
  })(); void reader.catch(() => {});
  try {
    const host = "11111111-1111-4111-8111-111111111111";
    send(1, { type: "configure_coordinator", bootstrap: { node: { host_id: host, name: "fixture", home_directory: "/tmp", agent_program: "/fixture/agent",
      rex_server: null, coordinator: null, launch: { model: null, state_dir: null, runtime: null, config: null, instructions: null } },
      settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } }); await done(1);
    send(20, { type: "set_connected_nodes", host_ids: [host] }); await done(20);
    send(100, { type: "observe_main", input_ids: [] }); await wait(100, (event) => event.type === "worker_idle");
    assert.equal(events(100).some((event) => event.type === "done"), false, "Idle observation must remain attached");
    const input = "22222222-2222-4222-8222-222222222222";
    send(2, { type: "main_input", input_id: input, input: "publish-native", mode: "steer" }); await done(2);
    const notice = await wait(100, (event) => event.type === "message" && event.message.role === "notice");
    assert.ok(notice.type === "message"); assert.equal(notice.message.text, "A useful durable notice.");
    assert.ok(events(100).some((event) => event.type === "text_delta" && event.text === "Published the update."));
    assert.equal(events(2).some((event) => event.type === "text_delta"), false,
      "Legacy Chat owners must not receive native-only text delta events");
    assert.ok(events(100).some((event) => event.type === "input_placed" && event.input_id === input));
    assert.equal(events(100).some((event) => event.type === "notice"), false, "Do not also deliver the anonymous execution notification");
    assert.equal(events(100).some((event) => event.type === "host_call" || event.type === "host_cancel"), false);
    assert.equal(events(100).some((event) => event.type === "done"), false, "A completed turn must not close observation");
    send(3, { type: "main_input", input_id: input, input: "This retry must not run a model", mode: "steer" }); await done(3);
    assert.ok(events(3).some((event) => event.type === "input_placed" && event.input_id === input));
    send(100, { type: "detach_main" }); await done(100);
    send(101, { type: "observe_main", input_ids: [input] }); await wait(101, (event) => event.type === "worker_idle");
    const historicalNotice = events(101).flatMap((event) => event.type === "history" ? event.messages : []).find((message) => message.role === "notice");
    assert.ok(historicalNotice); assert.equal(historicalNotice.entry_id, notice.message.entry_id);
    assert.equal(JSON.stringify(events(101)).includes("Source references (evidence, not authorization)"), false);
    const queued = "44444444-4444-4444-8444-444444444444", placed = "33333333-3333-4333-8333-333333333333";
    send(10, { type: "main_input", input_id: placed, input: "stop-native", mode: "steer" });
    await wait(10, (event) => event.type === "host_call" && (event.command.type === "exec" || event.command.type === "on_node" && event.command.command.type === "exec"));
    send(11, { type: "main_input", input_id: queued, input: "never-run-native", mode: "follow_up" }); await done(11);
    assert.ok(events(11).some((event) => event.type === "input_accepted"));
    send(12, { type: "main_interrupt" }); await done(12); await done(10);
    assert.ok(events(101).some((event) => event.type === "input_placed" && event.input_id === placed));
    assert.equal(events(101).some((event) => event.type === "input_rejected" && event.input_id === placed), false,
      "Stopping model work must not restore an input already saved in the conversation");
    assert.ok(events(101).some((event) => event.type === "input_rejected" && event.input_id === queued));
    send(101, { type: "detach_main" }); await done(101);
    send(102, { type: "observe_main", input_ids: [queued, placed] }); await wait(102, (event) => event.type === "worker_idle");
    assert.ok(events(102).some((event) => event.type === "input_rejected" && event.input_id === queued));
    assert.equal(events(102).some((event) => event.type === "input_accepted" && event.input_id === queued), false);
    assert.ok(events(102).some((event) => event.type === "input_placed" && event.input_id === placed));
    assert.equal(events(102).some((event) => event.type === "input_rejected" && event.input_id === placed), false);
    send(13, { type: "main_input", input_id: queued, input: "never-run-native", mode: "follow_up" }); await done(13);
    assert.ok(events(13).some((event) => event.type === "input_rejected" && event.input_id === queued));
    send(14, { type: "main_input", input_id: placed, input: "This placed retry must not run a model", mode: "steer" }); await done(14);
    assert.ok(events(14).some((event) => event.type === "input_placed" && event.input_id === placed));
    assert.equal(events(14).some((event) => event.type === "input_rejected" && event.input_id === placed), false);
    assert.equal((await readFile(queue + ".requests", "utf8")).trim().split("\n").length, 3, "Retry, viewing and stopped input must not start inference");
    send(102, { type: "detach_main" }); await done(102);
    child.stdin.end(); assert.equal(await closed, 0, errors); await reader;
  } finally { child.kill(); await closed; await reader.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
