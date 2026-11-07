import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, GenerationTask, Harness, LiveDoc, ToolResultEntry, ToolTask, UserEntry, type GenerationCheckpoint, type Harness as NativeHarness, type TaskId } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CoordinatorEnvironment } from "../src/environment.js";
import { ChatGptAuth } from "../src/auth.js";
import * as mainObservation from "../src/main_observation.js";
import { DEFAULT_MODEL } from "../src/models.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";

const host = "11111111-1111-4111-8111-111111111111";
async function open(path: string) {
  const storage = await SqliteStorage.open(await openNodeSqliteDatabase(path));
  const session = await Harness.open(storage,
    { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  return { storage, session, root: await session.root(BACKGROUND_CONTEXT) };
}

async function configure(session: NativeHarness) {
  await new CoordinatorEnvironment(session).configure({ node: {
    host_id: host, name: "fixture", home_directory: "/tmp", agent_program: "/fixture/agent", rex_server: null, coordinator: null,
    launch: { model: null, state_dir: null, runtime: null, config: null, instructions: null },
  }, settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } });
}

// Native durable records model a process cut off five times in pi.generation's
// request phase. The missing model makes recovery settle without any provider.
async function seed(path: string, deferred = false) {
  const app = await open(path);
  let task;
  let cutoff;
  try {
    await configure(app.session);
    ({ task, cutoff } = await app.root.commit(async (tx) => {
      const user = await tx.appendEntry(UserEntry, app.root.id, { model: [{ role: "user", content: "Original saved input", timestamp: 1 }] });
      const submission = await tx.createSubmission({ type: "input", conversationId: app.root.id,
        requestId: "placed", status: "placed", entry: user.id });
      const task = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } });
      const live = await tx.doc(LiveDoc, app.root.id);
      live.run = { taskId: task, inputs: [submission.id] }; live.generation = { attempt: 1 };
      const answer = await tx.appendEntry(AssistantEntry, app.root.id, {});
      await tx.createSubmission({ type: "input", conversationId: app.root.id, requestId: "completed",
        status: "done", entry: user.id, answer: answer.id });
      await tx.createSubmission({ type: "input", conversationId: app.root.id, requestId: "stopped",
        status: "unanswered", entry: user.id, reason: "aborted" });
      return { task, cutoff: user.id };
    }, BACKGROUND_CONTEXT));
    const record = await app.session.getTask(task, BACKGROUND_CONTEXT); assert.ok(record);
    const checkpoint: GenerationCheckpoint = deferred ? { phase: "retry", attempt: 1, until: Date.now() + 60_000 }
      : { phase: "request", attempt: 1, model: { provider: "missing", modelId: "unavailable" }, thinkingLevel: "off", streamOptions: {}, cutoff };
    // The Harness stays paused while the persisted crash checkpoint is installed.
    await app.storage.commit([{ type: "task", value: { ...record, restarts: 5,
      state: { status: "pending", checkpoint } } }], BACKGROUND_CONTEXT);
  } finally { await app.session.close(BACKGROUND_CONTEXT); }
  const parked = await open(path);
  try {
    const queued = await parked.root.submit({ type: "input", content: "Original queued input", requestId: "queued", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    assert.equal((await queued.status(BACKGROUND_CONTEXT)).status, "queued");
    assert.equal((await parked.session.inspect(BACKGROUND_CONTEXT)).tasks.find((item) => item.record.id === task)?.state.kind, "blocked");
  } finally { await parked.session.close(BACKGROUND_CONTEXT); }
  return task;
}

function bridge(directory: string, options: { holdGuidance?: boolean; denyNetwork?: boolean; beforeHostReply?: () => Promise<void> } = {}) {
  const permissions = options.denyNetwork === true ? ["--permission", "--allow-fs-read=*", "--allow-fs-write=*", "--allow-addons", "--allow-ffi"] : [];
  const child = spawn(process.execPath, ["--no-warnings", ...permissions, fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: directory, OPENAI_API_KEY: "sk-invented-unused-fixture",
      ...(process.env.AGENT_SQLITE_VEC === undefined ? {} : { AGENT_SQLITE_VEC: process.env.AGENT_SQLITE_VEC }) } });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const frames: RuntimeEvent[] = [], changes = new Set<() => void>();
  let heldGuidance: { request: number; call_id: string } | undefined;
  let replying = true;
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (value: string) => { errors += value; });
  const diagnostics = () => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed,
    inputEnded: child.stdin.writableEnded, stderr: errors.slice(-4096), frames: frames.slice(-16).map((frame) => ({
      id: frame.id, type: frame.event.type, ...(frame.event.type === "host_call" ? { command: frame.event.command.type } : {}),
    })) });
  child.stdin.on("error", (error) => { console.error("Owned bridge stdin failed", diagnostics()); throw error; });
  const send = (id: number, command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id, command }) + "\n",
    (error) => { assert.ifError(error); });
  const events = (id: number) => frames.filter((frame) => frame.id === id).map((frame) => frame.event);
  const wait = (id: number, predicate: (event: RuntimeEventKind) => boolean): Promise<RuntimeEventKind> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { changes.delete(check); reject(new Error(`Request ${id} stalled: ${errors}`)); }, 5_000);
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
      if (command.type === "reload_guidance" && options.holdGuidance === true) {
        heldGuidance = { request: frame.id, call_id: frame.event.call_id }; continue;
      }
      const result: HostResult = command.type === "reload_guidance"
        ? { type: "shared_guidance", global: { text: "", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] }
        : command.type === "project_guidance" ? { type: "project_guidance", snapshot: { text: "", sources: [] } }
        : { type: "failed", message: "No external services are installed" };
      if (options.beforeHostReply !== undefined) await options.beforeHostReply();
      if (replying) send(frame.id, { type: "host_reply", call_id: frame.event.call_id, result });
    }
  })(); void reader.catch(() => {});
  const releaseGuidance = () => {
    assert.ok(heldGuidance);
    send(heldGuidance.request, { type: "host_reply", call_id: heldGuidance.call_id,
      result: { type: "shared_guidance", global: { text: "", sources: [] }, workflow_policy: "", context_repositories: [], context_sources: [] } });
    heldGuidance = undefined;
  };
  const stop = async () => {
    // Retire the reply producer, then flush writes already accepted by stdin
    // before terminating its consumer. Buffered host calls may still arrive.
    replying = false;
    try {
      if (!child.stdin.writableEnded && !child.stdin.destroyed) {
        await new Promise<void>((resolve, reject) => child.stdin.write("", (error) => error ? reject(error) : resolve()));
      }
    } finally { child.kill("SIGKILL"); await closed; }
    await reader;
  };
  return { child, closed, reader, send, events, wait, done, releaseGuidance, diagnostics, stop, errors: () => errors };
}

async function records(session: NativeHarness) {
  const root = await session.root(BACKGROUND_CONTEXT);
  return session.commit(async (tx) => ({
    tasks: (await tx.scanTasks({}, 100)).items,
    submissions: (await Promise.all(["placed", "queued", "completed", "stopped"].map((id) => tx.submissionByRequest(root.id, id)))).filter((item) => item !== undefined),
    entries: (await tx.scanEntries({ conversationId: root.id }, 100)).items,
  }), BACKGROUND_CONTEXT);
}

test("source triage recovers its parked tool without replaying an unsafe effect or unrelated work", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-source-parked-")), path = join(directory, "session.sqlite");
  let peer: ReturnType<typeof bridge> | undefined;
  let durable = "Recovery readback has not started";
  let releaseReply = () => {};
  const replyGate = new Promise<void>((resolve) => { releaseReply = resolve; });
  try {
    await new ChatGptAuth(directory).status();
    peer = bridge(directory, { denyNetwork: true });
    peer.send(1, { type: "ingest_source", expected_checkpoint: null, batch: {
      source: { provider: "mail", account: "fixture" }, checkpoint: { value: "retained" }, coverage: { status: "complete" },
      events: [{ id: "retained-event", version: "original", source: { provider: "mail", account: "fixture", thread_id: "original" },
        title: "Original source evidence", text: "Continue the existing hardware question." }],
    } }); await peer.done(1);
    peer.send(2, { type: "triage_sources", instructions: "", model: { ...DEFAULT_MODEL, model_id: "missing-fixture-model" }, cwd: "/tmp", hosts: [] });
    await peer.done(2);
    assert.ok(peer.events(2).some((event) => event.type === "failure"), "The real triage path must retain a claim when model preflight fails");
    peer.child.stdin.end(); assert.equal(await peer.closed, 0, peer.errors()); await peer.reader;

    const app = await open(path);
    const round = await (async () => {
      try {
        const conversations = (await app.storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT)).items;
        const candidates = conversations.filter((record) => record.id !== app.root.id);
        assert.equal(candidates.length, 1, "Production triage must create exactly one owning source conversation");
        const record = candidates[0]; assert.ok(record);
        const conversation = await app.session.conversation(record.id, BACKGROUND_CONTEXT); assert.ok(conversation);
        const created = await conversation.commit(async (tx) => {
          const user = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "Original admitted source review", timestamp: 1 }] });
          const submission = await tx.createSubmission({ type: "input", conversationId: conversation.id,
            requestId: "interrupted-source-review", status: "placed", entry: user.id });
          const generation = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } });
          const message: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id: "interrupted-source",
            name: "dismiss_source_events", arguments: { keys: ["retained-event"], reason: "Existing judgment" } }], api: "openai-responses",
            provider: "openai", model: DEFAULT_MODEL.model_id, stopReason: "toolUse", timestamp: 1,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const assistant = await tx.appendEntry(AssistantEntry, conversation.id, { model: [message] });
          const tool = await tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId: "interrupted-source" },
            { ownership: { kind: "task", taskId: generation } });
          const unrelated = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, background: true });
          const live = await tx.doc(LiveDoc, conversation.id);
          live.run = { taskId: generation, inputs: [submission.id] };
          live.tools = [{ taskId: tool, callId: "interrupted-source", name: "dismiss_source_events", status: "running" }];
          return { generation, tool, assistant: assistant.id, unrelated, conversation: conversation.id };
        }, BACKGROUND_CONTEXT);
        const saved = await app.session.commit(async (tx) => ({
          generation: await tx.task(created.generation), tool: await tx.task(created.tool), unrelated: await tx.task(created.unrelated),
        }), BACKGROUND_CONTEXT);
        assert.ok(saved.generation && saved.tool && saved.unrelated);
        const unrelated = { ...saved.unrelated, restarts: 5 };
        await app.storage.commit([
          { type: "task", value: { ...saved.generation, restarts: 0, state: { status: "waiting", on: [created.tool], policy: "allSettled",
            checkpoint: { phase: "tools", assistant: created.assistant, tools: [created.tool], pending: [] } } } },
          { type: "task", value: { ...saved.tool, restarts: 5, state: { status: "pending", checkpoint: { phase: "execute",
            arguments: { keys: ["retained-event"], reason: "Existing judgment" }, replay: "unsafe" } } } },
          { type: "task", value: unrelated },
        ], BACKGROUND_CONTEXT);
        return { ...created, unrelatedRecord: unrelated };
      } finally { await app.session.close(BACKGROUND_CONTEXT); }
    })();

    peer = bridge(directory, { denyNetwork: true, beforeHostReply: () => replyGate });
    peer.send(3, { type: "triage_sources", instructions: "", model: DEFAULT_MODEL, cwd: "/tmp", hosts: [] });
    const readback = await SqliteStorage.open(await openNodeSqliteDatabase(path));
    try {
      const deadline = Date.now() + 5_000;
      let tool = await readback.task(round.tool, BACKGROUND_CONTEXT);
      while (tool?.state.status !== "terminal") {
        durable = JSON.stringify({ tool });
        assert.ok(Date.now() < deadline, "Production source triage must release its parked native tool: " + JSON.stringify(peer.events(3)) + peer.errors());
        await new Promise((resolve) => setTimeout(resolve, 10));
        tool = await readback.task(round.tool, BACKGROUND_CONTEXT);
      }
      const entries = (await readback.scanEntries({ conversationId: round.conversation }, 100, undefined, BACKGROUND_CONTEXT)).items;
      const result = entries.find((entry) => ToolResultEntry.is(entry)); assert.ok(result);
      assert.ok(result.model?.some((message) => message.role === "toolResult" && message.isError &&
        message.content.some((part) => part.type === "text" && part.text.includes("was interrupted"))),
      "Native recovery must retain an interrupted result, never execute the unsafe tool again");
      const unrelated = await readback.task(round.unrelated, BACKGROUND_CONTEXT);
      durable = JSON.stringify({ tool, unrelated, result });
      assert.deepEqual(unrelated, round.unrelatedRecord,
        "Source recovery must not retry unrelated background work");
    } finally { await readback.close(BACKGROUND_CONTEXT); }
    // Keep a genuine host reply queued across the owned process shutdown.
    // The recovery assertions above must still hold before this cutover.
    await peer.wait(3, (event) => event.type === "host_call");
  } finally {
    t.diagnostic("Owned source recovery before cleanup: " + JSON.stringify({ child: peer?.diagnostics(), durable: durable.slice(-12000) }));
    const stopping = peer?.stop();
    await peer?.closed;
    releaseReply();
    await stopping;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const input_id of ["placed", "queued"]) test(`explicit retry reclaims the saved ${input_id} input's execution owner`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-parked-")), path = join(directory, "session.sqlite");
  let peer: ReturnType<typeof bridge> | undefined;
  try {
    const task = await seed(path);
    const before = await open(path);
    const saved = await records(before.session); await before.session.close(BACKGROUND_CONTEXT);
    peer = bridge(directory);
    peer.send(1, { type: "set_connected_nodes", host_ids: [host] }); await peer.done(1);
    peer.send(2, { type: "main_input", input_id, input: "Do not replace the original saved input", mode: "steer" });
    const claimed = await peer.wait(2, (event) => event.type === "input_accepted" && event.work !== undefined && event.work.type !== "blocked" || event.type === "done");
    assert.equal(claimed.type, "input_accepted", "An unfinished saved admission must resume its execution owner before returning");
    if (input_id === "queued") {
      // No provider exists for the interrupted request. Its queued successor is
      // retained by Pi's keep policy until the explicit stop withdraws it.
      const readback = await SqliteStorage.open(await openNodeSqliteDatabase(path));
      try {
        const deadline = Date.now() + 5_000;
        while ((await readback.task(task, BACKGROUND_CONTEXT))?.state.status !== "terminal") {
          assert.ok(Date.now() < deadline, "The parked generation must settle after explicit retry");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally { await readback.close(BACKGROUND_CONTEXT); }
      peer.send(3, { type: "main_interrupt" }); await peer.done(3);
    }
    await peer.done(2);
    peer.child.stdin.end(); assert.equal(await peer.closed, 0, peer.errors()); await peer.reader;
    const after = await open(path);
    try {
      const current = await records(after.session);
      assert.deepEqual(current.submissions.map((input) => input.id), saved.submissions.map((input) => input.id), "Reclaim must reuse every native submission ID");
      assert.deepEqual(current.entries.filter((entry) => entry.kind === "pi.user"), saved.entries.filter((entry) => entry.kind === "pi.user"), "Reclaim must retain the original saved text without another placement");
      const recovered = await after.session.getTask(task, BACKGROUND_CONTEXT);
      assert.equal(recovered?.state.status, "terminal");
      assert.equal(recovered?.restarts ?? 0, 0, "Explicit continuation must clear the parked generation's restart budget");
    } finally { await after.session.close(BACKGROUND_CONTEXT); }
  } finally {
    peer?.child.kill("SIGKILL"); await peer?.closed; await peer?.reader.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh main input resumes the parked foreground generation before waiting for its queued admission", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-new-input-")), path = join(directory, "session.sqlite");
  let peer: ReturnType<typeof bridge> | undefined;
  try {
    const task = await seed(path, true);
    peer = bridge(directory);
    peer.send(1, { type: "set_connected_nodes", host_ids: [host] }); await peer.done(1);
    peer.send(2, { type: "main_input", input_id: "new", input: "A new request", mode: "steer" });
    await peer.wait(2, (event) => event.type === "input_accepted");
    const readback = await SqliteStorage.open(await openNodeSqliteDatabase(path));
    try {
      let recovered = await readback.task(task, BACKGROUND_CONTEXT);
      assert.equal(recovered?.restarts ?? 0, 0, "A new explicit input must grant the old generation another attempt");
      // Acceptance grants execution ownership; Pi may still be transitioning
      // from running to the persisted retry sleep when that receipt arrives.
      const deadline = Date.now() + 5_000;
      while (recovered?.state.status === "running") {
        assert.ok(Date.now() < deadline, "The recovered generation must enter its native retry sleep");
        await new Promise((resolve) => setTimeout(resolve, 10));
        recovered = await readback.task(task, BACKGROUND_CONTEXT);
      }
      assert.equal(recovered?.state.status, "sleeping", "The original native retry checkpoint must resume before new admission waits");
      const root = (await readback.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]; assert.ok(root);
      assert.equal((await readback.submissionByRequest(root.id, "new", BACKGROUND_CONTEXT))?.status, "queued");
    } finally { await readback.close(BACKGROUND_CONTEXT); }
    peer.send(20, { type: "observe_main", input_ids: [] });
    await peer.wait(20, (event) => event.type === "history" && event.page_complete);
    peer.send(3, { type: "main_interrupt" }); await peer.done(3); await peer.done(2);
    await peer.wait(20, (event) => event.type === "worker_idle");
    for (const id of [2, 20]) {
      for (const input_id of ["queued", "new"]) {
        assert.equal(peer.events(id).filter((event) => event.type === "input_rejected" && event.input_id === input_id).length, 1,
          `Request ${id} must receive exactly one terminal receipt for aborted unplaced input ${input_id}`);
      }
      assert.equal(peer.events(id).some((event) => event.type === "input_rejected" && event.input_id === "placed"), false,
        "Stopping must preserve an input already placed in native history");
    }
    peer.send(20, { type: "detach_main" }); await peer.done(20);
    peer.send(21, { type: "observe_main", input_ids: ["placed", "queued", "new"] });
    await peer.wait(21, (event) => event.type === "worker_idle");
    for (const input_id of ["queued", "new"]) {
      assert.equal(peer.events(21).filter((event) => event.type === "input_rejected" && event.input_id === input_id).length, 1,
        "Reconnect must still reconcile each withdrawn input from its native submission");
    }
    assert.ok(peer.events(21).some((event) => event.type === "input_accepted" && event.input_id === "placed" && event.work?.type === "stopped"));
    assert.ok(peer.events(21).some((event) => event.type === "input_placed" && event.input_id === "placed"));
    assert.equal(peer.events(21).some((event) => event.type === "host_call" || event.type === "activity" || event.type === "failure"), false,
      "Reconciliation must not restart execution or replay a stopped input");
    peer.send(21, { type: "detach_main" }); await peer.done(21);
    peer.child.stdin.end(); assert.equal(await peer.closed, 0, peer.errors()); await peer.reader;
  } finally {
    peer?.child.kill("SIGKILL"); await peer?.closed; await peer?.reader.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconnect reports blocked, completed and stopped work without granting another restart", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-receipts-")), path = join(directory, "session.sqlite");
  let peer: ReturnType<typeof bridge> | undefined;
  try {
    const task = await seed(path);
    const before = await open(path);
    const saved = await records(before.session); await before.session.close(BACKGROUND_CONTEXT);
    const answer = saved.submissions.find((input) => input.requestId === "completed"); assert.ok(answer?.type === "input" && answer.status === "done");
    const expected = new Map([
      ["placed", { type: "blocked", reason: "restart_limit" }], ["queued", { type: "blocked", reason: "restart_limit" }],
      ["completed", { type: "completed", answer_entry_id: answer.answer.toString() }], ["stopped", { type: "stopped" }],
    ]);
    peer = bridge(directory);
    for (const id of [1, 2]) {
      peer.send(id, { type: "observe_main", input_ids: [...expected.keys()] }); await peer.wait(id, (event) => event.type === "failure");
      const events = peer.events(id);
      for (const [input_id, work] of expected) {
        const receipt = events.find((event) => event.type === "input_accepted" && event.input_id === input_id);
        assert.ok(receipt?.type === "input_accepted"); assert.deepEqual(receipt.work, work);
      }
      assert.equal(events.some((event) => event.type === "host_call" || event.type === "activity"), false);
      peer.send(id, { type: "detach_main" }); await peer.done(id);
    }
    for (const [id, input_id] of [[3, "completed"], [4, "stopped"]] satisfies [number, string][]) {
      peer.send(id, { type: "main_input", input_id, input: "This retry must not run", mode: "steer" }); await peer.done(id);
      assert.equal(peer.events(id).some((event) => event.type === "host_call" || event.type === "failure"), false,
        "Terminal retries need only their durable receipt, even with no connected execution host");
    }
    peer.child.stdin.end(); assert.equal(await peer.closed, 0, peer.errors()); await peer.reader;
    const after = await open(path);
    try {
      assert.deepEqual(await records(after.session), saved, "Passive reconnect and terminal retry must not change native records");
      assert.equal((await after.session.getTask(task, BACKGROUND_CONTEXT))?.restarts, 5);
    } finally { await after.session.close(BACKGROUND_CONTEXT); }
  } finally {
    peer?.child.kill("SIGKILL"); await peer?.closed; await peer?.reader.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("foreground recovery leaves parked tools, owned generations and background work untouched", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-retry-scope-")), path = join(directory, "session.sqlite");
  try {
    const generation = await seed(path);
    let app = await open(path);
    const protectedTasks: TaskId[] = await app.root.commit(async (tx) => {
      const assistant = await tx.appendEntry(AssistantEntry, app.root.id, {});
      const tool = await tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId: "never-replay" }, { ownership: { kind: "conversation" } });
      const owned = await tx.createTask(GenerationTask, {}, { ownership: { kind: "task", taskId: tool } });
      const background = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, background: true });
      const other = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const elsewhere = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: other.id });
      return [tool, owned, background, elsewhere];
    }, BACKGROUND_CONTEXT);
    const taskRecord = (id: TaskId) => app.session.commit((tx) => tx.task(id), BACKGROUND_CONTEXT);
    const protectedRecords = await Promise.all(protectedTasks.map(taskRecord));
    for (const record of protectedRecords) {
      assert.ok(record);
      await app.storage.commit([{ type: "task", value: { ...record, restarts: 5 } }], BACKGROUND_CONTEXT);
    }
    await app.session.close(BACKGROUND_CONTEXT); app = await open(path);
    try {
      const parked = await Promise.all(protectedTasks.map(taskRecord));
      await mainObservation.recoverMainGeneration(app.session, app.root);
      await app.session.waitForTask(generation, BACKGROUND_CONTEXT);
      assert.deepEqual(await Promise.all(protectedTasks.map(taskRecord)), parked);
      const queued = await mainObservation.reconcileMainInput(app.root, "queued", app.session);
      assert.deepEqual(queued, [{ type: "input_accepted", input_id: "queued", work: { type: "queued" } }],
        "Unrelated parked work must not block a saved input after its run settles");
    } finally { await app.session.close(BACKGROUND_CONTEXT); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const state of ["parked", "parked_tool", "missing_task", "completed"]) test(`observation with no pending IDs reports ${state} main work after history is ready`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-observed-state-")), path = join(directory, "session.sqlite");
  let peer: ReturnType<typeof bridge> | undefined;
  try {
    if (state === "completed") {
      const app = await open(path);
      try {
        await configure(app.session);
        await app.root.commit(async (tx) => {
          const user = await tx.appendEntry(UserEntry, app.root.id, { model: [{ role: "user", content: "A completed request", timestamp: 1 }] });
          const answer = await tx.appendEntry(AssistantEntry, app.root.id, {});
          await tx.createSubmission({ type: "input", conversationId: app.root.id, requestId: "completed", status: "done", entry: user.id, answer: answer.id });
        }, BACKGROUND_CONTEXT);
      } finally { await app.session.close(BACKGROUND_CONTEXT); }
    } else {
      const task = await seed(path);
      if (state === "missing_task" || state === "parked_tool") {
        const app = await open(path);
        try {
          const record = await app.session.getTask(task, BACKGROUND_CONTEXT); assert.ok(record);
          if (state === "missing_task") {
            await app.storage.commit([{ type: "task", value: { ...record, kind: "fixture.unavailable", restarts: 0 } }], BACKGROUND_CONTEXT);
          } else {
            const round = await app.root.commit(async (tx) => {
              const assistant = await tx.appendEntry(AssistantEntry, app.root.id, {});
              const tool = await tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId: "parked-effect" },
                { ownership: { kind: "task", taskId: task } });
              const live = await tx.doc(LiveDoc, app.root.id);
              delete live.generation;
              live.tools = [{ taskId: tool, callId: "parked-effect", name: "exec", status: "pending" }];
              return { assistant: assistant.id, tool };
            }, BACKGROUND_CONTEXT);
            const child = await app.root.commit((tx) => tx.task(round.tool), BACKGROUND_CONTEXT); assert.ok(child);
            await app.storage.commit([
              { type: "task", value: { ...record, restarts: 0, state: { status: "waiting", on: [round.tool], policy: "allSettled",
                checkpoint: { phase: "tools", assistant: round.assistant, tools: [round.tool], pending: [] } } } },
              { type: "task", value: { ...child, restarts: 5 } },
            ], BACKGROUND_CONTEXT);
          }
        } finally { await app.session.close(BACKGROUND_CONTEXT); }
      }
    }
    const before = await open(path);
    const saved = await records(before.session); await before.session.close(BACKGROUND_CONTEXT);
    peer = bridge(directory);
    peer.send(1, { type: "observe_main", input_ids: [] });
    const status = await peer.wait(1, (event) => event.type === "failure" || event.type === "worker_idle");
    if (state === "completed") {
      assert.equal(status.type, "worker_idle");
      assert.equal(peer.events(1).some((event) => event.type === "failure"), false, "Completed work must not report a runtime block");
    } else {
      assert.equal(status.type, "failure", "A blocked native run must remain visible without locally pending input IDs");
      assert.ok(status.type === "failure");
      if (state === "parked") assert.match(status.message, /paused after repeated restarts.*Send a message to resume/u);
      else if (state === "parked_tool") {
        assert.match(status.message, /inspect.*prior.*outcome/iu);
        assert.doesNotMatch(status.message, /send a message.*resume/iu, "An ordinary message must not promise to replay a parked effect");
      } else assert.match(status.message, /worker\/runtime update required/iu);
      assert.equal(status.code, "invalid_request", "Paused work is not a broken coordinator connection");
      const events = peer.events(1), ready = events.findIndex((event) => event.type === "history" && event.page_complete);
      assert.ok(ready >= 0 && events.indexOf(status) > ready, "Blocked status must follow history readiness on the same observer");
      assert.equal(events.some((event) => event.type === "worker_idle" || event.type === "host_call" || event.type === "activity"), false);
    }
    peer.send(1, { type: "detach_main" }); await peer.done(1);
    peer.child.stdin.end(); assert.equal(await peer.closed, 0, peer.errors()); await peer.reader;
    const after = await open(path);
    try { assert.deepEqual(await records(after.session), saved, "Observing blocked or completed work must leave its native records unchanged"); }
    finally { await after.session.close(BACKGROUND_CONTEXT); }
  } finally {
    peer?.child.kill("SIGKILL"); await peer?.closed; await peer?.reader.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reclaimed owner stays attached for its existing follow-up and a concurrent admission", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-follow-up-")), path = join(directory, "session.sqlite");
  let peer: ReturnType<typeof bridge> | undefined;
  try {
    const generation = await seed(path), app = await open(path);
    try {
      const record = await app.session.getTask(generation, BACKGROUND_CONTEXT); assert.ok(record);
      const round = await app.root.commit(async (tx) => {
        const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Original request finished" }], api: "openai-responses",
          provider: "openai", model: DEFAULT_MODEL.model_id, stopReason: "stop", timestamp: 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const assistant = await tx.appendEntry(AssistantEntry, app.root.id, { model: [message] });
        const result = await tx.appendEntry(ToolResultEntry, app.root.id, { data: { diagnostics: [] } });
        const tool = await tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId: "completed-effect" },
          { ownership: { kind: "task", taskId: generation } });
        const live = await tx.doc(LiveDoc, app.root.id);
        delete live.generation;
        live.tools = [{ taskId: tool, callId: "completed-effect", name: "exec", status: "done", entry: result.id }];
        return { assistant: assistant.id, result: result.id, tool };
      }, BACKGROUND_CONTEXT);
      const child = await app.root.commit((tx) => tx.task(round.tool), BACKGROUND_CONTEXT); assert.ok(child);
      const { memos: _memos, ...endedChild } = child;
      await app.storage.commit([
        { type: "task", value: { ...record, state: { status: "pending",
          checkpoint: { phase: "tools", assistant: round.assistant, tools: [round.tool], pending: [] } } } },
        { type: "task", value: { ...endedChild, state: { status: "terminal", outcome: { status: "completed",
          result: { kind: "model", entryId: round.result, control: { terminate: true } } } } } },
      ], BACKGROUND_CONTEXT);
    } finally { await app.session.close(BACKGROUND_CONTEXT); }
    // Native completion hands the run to its saved follow-up. The real guidance
    // hook must still reach the owner's host before inference. Network access is
    // denied, and the hook remains held until the test interrupts the run.
    await new ChatGptAuth(directory).status();
    peer = bridge(directory, { holdGuidance: true, denyNetwork: true });
    peer.send(1, { type: "set_connected_nodes", host_ids: [host] }); await peer.done(1);
    peer.send(2, { type: "main_input", input_id: "placed", input: "Do not submit this duplicate text", mode: "steer" });
    const boundary = await peer.wait(2, (event) => event.type === "host_call" || event.type === "done");
    assert.equal(boundary.type, "host_call", "The saved follow-up must reach workspace guidance before its execution owner is released: " + JSON.stringify(peer.events(2)) + peer.errors());
    peer.send(5, { type: "status" }); await peer.done(5);
    assert.equal(peer.events(2).some((event) => event.type === "done"), false, "The owner must stay attached while the saved follow-up is using its host");
    assert.equal(peer.events(2).filter((event) => event.type === "answer" && event.text === "Original request finished").length, 1);
    peer.send(3, { type: "main_input", input_id: "concurrent", input: "A concurrent follow-up", mode: "follow_up" }); await peer.done(3);
    assert.ok(peer.events(3).some((event) => event.type === "input_accepted" && event.input_id === "concurrent"));
    const readback = await SqliteStorage.open(await openNodeSqliteDatabase(path));
    try {
      const inputs = (await readback.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT)).items;
      for (const input_id of ["placed", "queued", "concurrent"]) assert.equal(inputs.filter((input) => input.requestId === input_id).length, 1);
      assert.equal(inputs.find((input) => input.requestId === "queued")?.status, "placed");
      assert.equal(inputs.find((input) => input.requestId === "concurrent")?.status, "queued");
    } finally { await readback.close(BACKGROUND_CONTEXT); }
    peer.send(4, { type: "main_interrupt" }); peer.releaseGuidance(); await peer.done(4); await peer.done(2);
    peer.child.stdin.end(); assert.equal(await peer.closed, 0, peer.errors()); await peer.reader;
  } finally {
    peer?.child.kill("SIGKILL"); await peer?.closed; await peer?.reader.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
