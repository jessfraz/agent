import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DEFAULT_MODEL } from "../src/models.js";
import { history } from "../src/transcript.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";

// Exercise real admission, tools, native SQLite, owner answers and observation.
// Only the external provider and execution host are synthetic.
for (const commentary of [false, true]) test(`main replies cover silent direct inputs and steering${commentary ? " after visible commentary" : ""} without duplicating real replies or retries`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-response-")), queue = join(directory, "responses.json");
  await writeFile(queue, JSON.stringify({
    "silent-ordinary": [{ text: "" }],
    "active-original": [{ tool: "exec", args: { program: "held", args: [] }, ...(commentary ? { commentary: "Checking the original request before the later steer." } : {}) }],
    "active-steer": [{ text: "" }],
    "real-answer": [{ text: "The requested result is ready." }],
    "real-notice": [{ tool: "notify", args: { keys: [], text: "The requested correction is saved." } }, { text: "" }],
    "queued-followup": [{ text: "" }],
  }));
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const frames: RuntimeEvent[] = [], changes = new Set<() => void>();
  let errors = "", held: { request: number; call: string } | undefined, executions = 0;
  child.stderr.setEncoding("utf8").on("data", (text: string) => { errors += text; });
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n");
  const events = (id: number) => frames.filter((frame) => frame.id === id).map((frame) => frame.event);
  const wait = (id: number, predicate: (event: RuntimeEventKind) => boolean): Promise<RuntimeEventKind> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { changes.delete(check); reject(new Error(`Request ${id} stalled: ${errors}`)); }, 5_000);
    const check = () => { const event = events(id).find(predicate); if (event !== undefined) { clearTimeout(timer); changes.delete(check); resolve(event); } };
    changes.add(check); check();
  });
  const done = (id: number) => wait(id, (event) => event.type === "done");
  const replies = (id: number) => events(id).flatMap((event) => event.type === "answer" && event.text.trim() ? [event] : []);
  const reader = (async () => {
    for await (const line of protocolLines(child.stdout)) {
      const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame);
      for (const check of changes) check();
      if (frame.event.type !== "host_call") continue;
      let command = frame.event.command; while (command.type === "on_node") command = command.command;
      if (command.type === "exec") { held = { request: frame.id, call: frame.event.call_id }; executions += 1; continue; }
      const result: HostResult = command.type === "reload_guidance" ? { type: "shared_guidance", global: { text: "Keep routine receipts and background work quiet.", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] }
        : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
        : { type: "failed", message: "Synthetic retrieval disabled" };
      send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
    }
  })(); void reader.catch(() => {});
  try {
    const host = "11111111-1111-4111-8111-111111111111";
    send(1, { type: "configure_coordinator", bootstrap: { node: { host_id: host, name: "fixture", home_directory: "/tmp", agent_program: "/fixture/agent", rex_server: null, coordinator: null,
      launch: { model: null, state_dir: null, runtime: null, config: null, instructions: null } }, settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } }); await done(1);
    send(2, { type: "set_connected_nodes", host_ids: [host] }); await done(2);
    send(100, { type: "observe_main", input_ids: [] }); await wait(100, (event) => event.type === "worker_idle");
    send(3, { type: "main_input", input_id: "ordinary", input: "silent-ordinary", mode: "steer" }); await done(3);
    const ordinary = replies(3); assert.equal(ordinary.length, 1, "A silent completed direct request needs a visible, truthful response");
    assert.match(ordinary[0]?.text ?? "", /no written response|did not produce a written response/i);
    assert.ok(ordinary[0]?.entry_id); assert.deepEqual(replies(100), ordinary, "The observer receives the same durable reply identity");
    send(4, { type: "main_input", input_id: "ordinary", input: "A retry must not run inference", mode: "steer" }); await done(4);
    assert.ok(replies(4).length <= 1); for (const reply of replies(4)) assert.deepEqual(reply, ordinary[0], "A replay must retain the same canonical answer identity"); assert.equal(replies(100).length, 1);
    const activeStarted = frames.length;
    send(5, { type: "main_input", input_id: "active", input: "active-original", mode: "steer" });
    await wait(5, (event) => event.type === "host_call" && (event.command.type === "exec" || event.command.type === "on_node" && event.command.command.type === "exec"));
    if (commentary) await wait(100, (event) => event.type === "message" && event.message.role === "commentary" && event.message.text.includes("before the later steer"));
    send(6, { type: "conversation_input", conversation_id: "1", input_id: "steer", input: "active-steer", mode: "steer" }); await done(6);
    send(7, { type: "main_input", input_id: "followup", input: "queued-followup", mode: "follow_up" }); await done(7);
    assert.equal(events(6).filter((event) => event.type === "input_accepted").length, 1);
    assert.equal(events(7).filter((event) => event.type === "input_accepted").length, 1);
    assert.equal(events(100).some((event) => event.type === "input_placed" && (event.input_id === "steer" || event.input_id === "followup")), false,
      "Admission cannot claim placement or a response while the native tool still owns the boundary");
    assert.ok(held); send(held.request, { type: "host_reply", call_id: held.call, result: { type: "process", exit_code: 0, stdout: "Checked", stderr: "", truncated: false } });
    await done(5);
    assert.equal(replies(5).length, 2, "The later steer needs its shared native answer repaired live even when earlier commentary already answered the original input");
    assert.ok(events(5).filter((event) => event.type === "answer").every((event) => event.text.trim()), "An empty result is not a delivered visible answer");
    assert.equal(new Set(replies(5).map((reply) => reply.entry_id)).size, 2);
    const followup = events(100).find((event) => event.type === "input_placed" && event.input_id === "followup"); assert.ok(followup?.type === "input_placed");
    const firstReply = replies(5)[0], queuedReply = replies(5)[1]; assert.ok(firstReply?.entry_id && queuedReply?.entry_id);
    const repairIndex = frames.findIndex((frame) => frame.id === 5 && frame.event.type === "answer" && frame.event.entry_id === firstReply.entry_id && frame.event.text.trim());
    assert.ok(repairIndex > activeStarted && repairIndex < frames.findIndex((frame) => frame.id === 5 && frame.event.type === "done"), "The visible shared repair must arrive before done, without reconnect or another send");
    await wait(100, (event) => event.type === "worker_idle" && frames.findIndex((frame) => frame.event === event) > repairIndex);
    const idleIndex = frames.findLastIndex((frame) => frame.id === 100 && frame.event.type === "worker_idle");
    assert.ok(idleIndex > repairIndex, "ObserveMain must receive its visible repair before idle");
    if (commentary) {
      const seen = events(100).find((event) => event.type === "message" && event.message.role === "commentary" && event.message.text.includes("before the later steer"));
      const placed = events(100).find((event) => event.type === "input_placed" && event.input_id === "steer");
      assert.ok(seen?.type === "message" && placed?.type === "input_placed");
      assert.ok(Number(seen.message.entry_id) < Number(placed.entry_id) && Number(placed.entry_id) < Number(firstReply.entry_id));
    }
    assert.equal(replies(100).filter((reply) => reply.entry_id === firstReply.entry_id).length, 1);
    send(21, { type: "main_input", input_id: "steer", input: "A shared-answer retry must not execute another inference.", mode: "steer" }); await done(21);
    for (const reply of replies(21)) assert.deepEqual(reply, firstReply);
    assert.equal(replies(100).filter((reply) => reply.entry_id === firstReply.entry_id).length, 1);
    assert.ok(Number(firstReply.entry_id) < Number(followup.entry_id) && Number(followup.entry_id) < Number(queuedReply.entry_id),
      "Live fallback identities must preserve A1 before the already-placed queued U2, not the late diagnostic-write position");
    send(20, { type: "read_conversation", conversation_id: "1", cursor: null }); await done(20);
    const liveHistory = events(20).flatMap((event) => event.type === "history" ? event.messages : []);
    assert.ok(liveHistory.findIndex((row) => row.entry_id === firstReply.entry_id) < liveHistory.findIndex((row) => row.entry_id === followup.entry_id),
      "Durable live projection must put A1's diagnostic before U2");
    for (const input of ["active", "steer", "followup"]) assert.equal(events(100).filter((event) => event.type === "input_placed" && event.input_id === input).length, 1);
    assert.equal(executions, 1, "Steering must not cancel or repeat the existing effect");
    send(8, { type: "main_input", input_id: "answer", input: "real-answer", mode: "steer" }); await done(8);
    assert.deepEqual(replies(8).map((reply) => reply.text), ["The requested result is ready."], "A real final already satisfies the contract");
    const beforeNotice = replies(100).length;
    send(9, { type: "main_input", input_id: "notice", input: "real-notice", mode: "steer" }); await done(9);
    assert.equal(replies(9).length, 0, "A real main-owned notice must not get a canned second reply");
    assert.equal(replies(100).length, beforeNotice);
    assert.equal(events(100).filter((event) => event.type === "message" && event.message.role === "notice" && event.message.text === "The requested correction is saved.").length, 1);
    send(100, { type: "detach_main" }); await done(100);
    send(101, { type: "observe_main", input_ids: ["ordinary", "steer", "followup"] }); await wait(101, (event) => event.type === "worker_idle");
    const saved = events(101).flatMap((event) => event.type === "history" ? event.messages : []);
    for (const reply of [...ordinary, ...replies(5), ...replies(8)]) {
      assert.equal(saved.filter((message) => message.entry_id === reply.entry_id && message.text === reply.text && message.role === "final").length, 1,
        "Reconnect must recover the exact visible reply, not just an ephemeral receipt");
    }
    const requests = (await readFile(queue + ".requests", "utf8")).trim().split("\n");
    assert.equal(requests.length, 7, "No extra model calls for receipts, retries or fallback replies");
    // Supplement the actual delivery assertions with the real upstream prompt
    // producer, including the generation after native steering placement.
    for (const request of requests) {
      assert.match(request, /Direct user replies in this main chat:/);
      assert.match(request, /Keep routine receipts and background work quiet/,
        "The owner contract scopes quietness instead of replacing user guidance");
    }
    send(101, { type: "detach_main" }); await done(101);
    child.stdin.end(); assert.equal(await closed, 0, errors); await reader;
    const reopened = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
      { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
    try {
      const root = await reopened.root(BACKGROUND_CONTEXT);
      const recovered = (await history(root, null, reopened)).flatMap((event) => event.messages);
      assert.ok(recovered.findIndex((row) => row.entry_id === firstReply.entry_id) < recovered.findIndex((row) => row.entry_id === followup.entry_id),
        "Reopening must retain the same causal answer placement without timestamp sorting");
      const original = await root.commit((tx) => tx.submissionByRequest(root.id, "active"), BACKGROUND_CONTEXT);
      const steer = await root.commit((tx) => tx.submissionByRequest(root.id, "steer"), BACKGROUND_CONTEXT);
      assert.ok(original?.type === "input" && original.status === "done" && steer?.type === "input" && steer.status === "done");
      assert.equal(original.answer, steer.answer); assert.equal(original.answer.toString(), firstReply.entry_id);
      for (const reply of [...ordinary, ...replies(5)]) assert.equal(recovered.filter((message) =>
        message.entry_id === reply.entry_id && message.text === reply.text && message.role === "final").length, 1);
    } finally { await reopened.close(BACKGROUND_CONTEXT); }
  } finally { child.kill(); await closed; await reader.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
