import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "../src/models.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import type { InputMode } from "../src/generated/InputMode.js";

// Only inference and the execution host are synthetic. Kill the real bridge at
// a durable tool boundary, then reopen its SQLite store through the same CLI API.
const modes: InputMode[] = ["steer", "follow_up"];
for (const mode of modes) test(`main ${mode} after a runtime restart resumes its owner before admission`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-recovery-"));
  const queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({
    "original-request": [{ tool: "exec", args: { program: "held", args: [] } }, { text: "Recovered the original request." }],
    "next-request": [{ text: "Answered the next request." }],
  }));
  let executions = 0;
  const peers: ReturnType<typeof open>[] = [];
  function open() {
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const frames: RuntimeEvent[] = [], changes = new Set<() => void>();
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => { errors += text; });
    const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
    const events = (id: number) => frames.filter((frame) => frame.id === id).map((frame) => frame.event);
    const wait = (id: number, predicate: (event: RuntimeEventKind) => boolean): Promise<RuntimeEventKind> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { changes.delete(check); reject(new Error(`Request ${id} stalled during main recovery. ${errors}`)); }, 5_000);
      const check = () => {
        const event = events(id).find(predicate);
        if (event !== undefined) { clearTimeout(timer); changes.delete(check); resolve(event); }
      };
      changes.add(check); check();
    });
    const done = (id: number) => wait(id, (event) => event.type === "done");
    const reader = (async () => {
      for await (const line of protocolLines(child.stdout)) {
        const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame);
        for (const check of changes) check();
        if (frame.event.type !== "host_call") continue;
        let command = frame.event.command; while (command.type === "on_node") command = command.command;
        if (command.type === "exec") { executions += 1; continue; }
        const result: HostResult = command.type === "reload_guidance"
          ? { type: "shared_guidance", global: { text: "", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] }
          : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
          : { type: "failed", message: "Synthetic retrieval disabled" };
        send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
      }
    })(); void reader.catch(() => {});
    const peer = { child, closed, reader, send, events, wait, done, errors: () => errors };
    return peer;
  }
  try {
    const first = open(); peers.push(first);
    const host = "11111111-1111-4111-8111-111111111111";
    first.send(1, { type: "configure_coordinator", bootstrap: { node: {
      host_id: host, name: "fixture", home_directory: "/tmp", agent_program: "/fixture/agent", rex_server: null, coordinator: null,
      launch: { model: null, state_dir: null, runtime: null, config: null, instructions: null },
    }, settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } }); await first.done(1);
    first.send(2, { type: "set_connected_nodes", host_ids: [host] }); await first.done(2);
    first.send(3, { type: "main_input", input_id: "original", input: "original-request", mode: "steer" });
    const original = await first.wait(3, (event) => event.type === "input_placed");
    await first.wait(3, (event) => event.type === "host_call" &&
      (event.command.type === "exec" || event.command.type === "on_node" && event.command.command.type === "exec"));
    first.child.kill("SIGKILL"); await first.closed; await first.reader;

    const second = open(); peers.push(second);
    second.send(1, { type: "set_connected_nodes", host_ids: [host] }); await second.done(1);
    second.send(2, { type: "conversation_input", conversation_id: "1", input_id: "next", input: "next-request", mode });
    // Another sender must receive admission too, rather than wait forever on
    // the replacement owner's startup promise. Native IDs make this idempotent.
    second.send(3, { type: "main_input", input_id: "next", input: "next-request", mode });
    second.send(4, { type: "status" }); await second.done(4);
    await second.done(2); await second.done(3);
    assert.ok(second.events(2).some((event) => event.type === "answer" && event.text === "Answered the next request."));
    assert.ok(second.events(3).some((event) => event.type === "input_accepted" && event.input_id === "next"));
    assert.equal(executions, 1, "Recovery must not replay the interrupted execution host effect");
    second.send(5, { type: "main_input", input_id: "original", input: "Do not repeat this request", mode: "steer" }); await second.done(5);
    assert.deepEqual(second.events(5).find((event) => event.type === "input_placed"), original,
      "The original submission keeps its durable entry across recovery");
    second.send(6, { type: "read_conversation", conversation_id: "1", cursor: null }); await second.done(6);
    const messages = second.events(6).flatMap((event) => event.type === "history" ? event.messages : []);
    for (const text of ["original-request", "next-request", "Answered the next request."]) {
      assert.equal(messages.filter((message) => message.text === text).length, 1, `Keep exactly one saved ${text}`);
    }
    assert.equal(messages.filter((message) => message.text === "Recovered the original request.").length, mode === "steer" ? 0 : 1,
      "Steering joins the pending generation; follow-up waits for its answer");
    assert.equal((await readFile(queue + ".requests", "utf8")).trim().split("\n").length, mode === "steer" ? 2 : 3);
    second.child.stdin.end(); assert.equal(await second.closed, 0, second.errors()); await second.reader;
  } finally {
    for (const peer of peers) { peer.child.kill("SIGKILL"); await peer.closed; await peer.reader.catch(() => {}); }
    await rm(directory, { recursive: true, force: true });
  }
});
