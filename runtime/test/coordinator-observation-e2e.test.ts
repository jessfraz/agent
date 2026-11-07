import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, GenerationTask, Harness, LiveDoc, UserEntry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";

type StopProbe = { conversation_id: string; entry_id: string; input_id: string; steer_id: string; queued_id: string; root: boolean };

type Server = { child: ChildProcessWithoutNullStreams; closed: Promise<number | null>; errors(): string };

test("production coordinator reconciles saved input before history across a real socket and restart", { timeout: 300_000 }, async (t) => {
  const directory = await mkdtemp("/tmp/agent-observation-e2e-");
  const state = join(directory, "state"), bin = join(directory, "bin"), socket = join(state, "agent.sock");
  const input = "11111111-1111-4111-8111-111111111111", text = "Keep the original saved request.";
  const binary = process.env.AGENT_TEST_BINARY ?? fileURLToPath(new URL("../../../target/debug/beep-boop", import.meta.url));
  const runtime = fileURLToPath(new URL("../src/bridge.js", import.meta.url));
  const children: Server[] = [];
  try {
    await mkdir(state, { mode: 0o700 }); await mkdir(bin, { mode: 0o700 });
    // Node is the only installed helper. Missing optional Rex/SSH/provider
    // services are not replaced with scripts or test implementations.
    await symlink(process.execPath, join(bin, "node"));
    await writeFile(join(directory, "config.toml"), 'node_name = "coordinator-e2e"\njob_directories = []\n');
    await writeFile(join(directory, "AGENTS.md"), "Use only invented test data.\n");

    // Seed a real interrupted admission through Pi's transaction API. No model
    // runs, fake provider, SQL replacement or alternative coordinator is used.
    const database = await openNodeSqliteDatabase(join(state, "session.sqlite"));
    const storage = await SqliteStorage.open(database);
    const harness = await Harness.open(storage,
      { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
    let entry: string;
    const stopProbes: StopProbe[] = [];
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const original = await root.commit(async (tx) => {
        const saved = await tx.appendEntry(UserEntry, root.id,
          { model: [{ role: "user", content: text, timestamp: 1 }] });
        const submission = await tx.createSubmission({ type: "input", conversationId: root.id,
          requestId: input, status: "placed", entry: saved.id });
        return { entry_id: saved.id, submission_id: submission.id };
      }, BACKGROUND_CONTEXT);
      entry = original.entry_id.toString();
      const tasks = new TaskStore(harness, new ConversationModels());
      const task = await tasks.create({
        title: "Observation stop regression", outcome: "Retain the stopped inputs" });
      for (const conversation of [await tasks.conversation(task.conversation_id), root]) {
        const stoppedInput = conversation.id === root.id ? input : `current-${conversation.id}`;
        const steerInput = `steer-${conversation.id}`, queuedInput = `queue-${conversation.id}`;
        const { generation, entry_id } = await conversation.commit(async (tx) => {
          let entry_id = original.entry_id, submission_id = original.submission_id;
          if (conversation.id !== root.id) {
            const user = await tx.appendEntry(UserEntry, conversation.id,
              { model: [{ role: "user", content: "Keep the placed input", timestamp: 1 }] });
            const submission = await tx.createSubmission({ type: "input", conversationId: conversation.id,
              requestId: stoppedInput, status: "placed", entry: user.id });
            entry_id = user.id; submission_id = submission.id;
          }
          const generation = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } });
          const live = await tx.doc(LiveDoc, conversation.id);
          live.run = { taskId: generation, inputs: [submission_id] }; live.generation = { attempt: 1 };
          return { generation, entry_id: entry_id.toString() };
        }, BACKGROUND_CONTEXT);
        await conversation.submit({ type: "input", requestId: steerInput, content: "Keep the unplaced steer", whenBusy: "steer" }, BACKGROUND_CONTEXT);
        await conversation.submit({ type: "input", requestId: queuedInput, content: "Keep the unplaced follow-up", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
        const record = await harness.getTask(generation, BACKGROUND_CONTEXT); assert.ok(record);
        // A real persisted Pi retry holds this generation without a provider or
        // replacement execution service. The production interrupt must settle it.
        await storage.commit([{ type: "task", value: { ...record, state: { status: "pending",
          checkpoint: { phase: "retry", attempt: 1, until: Date.now() + 3_600_000 } } } }], BACKGROUND_CONTEXT);
        stopProbes.push({ conversation_id: conversation.id.toString(), entry_id, input_id: stoppedInput,
          steer_id: steerInput, queued_id: queuedInput, root: conversation.id === root.id });
      }
    } finally { await harness.close(BACKGROUND_CONTEXT); }

    async function start() {
      const started = performance.now();
      const child = spawn(binary, ["--state-dir", state, "--config", join(directory, "config.toml"),
        "--runtime", runtime, "--instructions", join(directory, "AGENTS.md"),
        "serve", "--local-only", "--no-sources"], {
        cwd: directory, detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: bin, HOME: directory, XDG_CONFIG_HOME: join(directory, "config"),
          XDG_DATA_HOME: join(directory, "data"), TMPDIR: directory,
          AGENT_SQLITE_VEC: process.env.AGENT_SQLITE_VEC },
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
      child.stdout.resume();
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("close", resolve); child.once("error", reject);
      });
      void closed.catch(() => {});
      const owned = { child, closed, errors: () => stderr }; children.push(owned);
      for (;;) {
        assert.equal(child.exitCode, null, stderr);
        assert.equal(child.signalCode, null, stderr);
        t.signal.throwIfAborted();
        try {
          await observe(false);
          t.diagnostic(`Production coordinator ready after ${Math.round(performance.now() - started)}ms`);
          return owned;
        } catch (error) {
          if (!(error instanceof Error && "code" in error &&
            (error.code === "ENOENT" || error.code === "ECONNREFUSED"))) throw error;
          await delay(10, undefined, { signal: t.signal });
        }
      }
    }
    async function observe(untilIdle = true): Promise<RuntimeEventKind[]> {
      const channel = createConnection({ path: socket, signal: t.signal });
      const request: RuntimeCommand = { type: "observe_main", input_ids: [input] };
      const events: RuntimeEventKind[] = [];
      try {
        channel.write(JSON.stringify(request) + "\n");
        for await (const line of protocolLines(channel)) {
          const event: unknown = JSON.parse(line), frame = { version: 1, id: 1, event };
          assert.ok(validEvent(frame), "The production server must emit its Rust-owned wire schema");
          events.push(frame.event);
          if (frame.event.type === "worker_idle" || !untilIdle && frame.event.type === "history" && frame.event.page_complete) return events;
          assert.notEqual(frame.event.type, "failure", JSON.stringify(frame.event));
        }
        throw new Error("Coordinator closed before completing the observation snapshot");
      } finally { channel.destroy(); }
    }
    async function stop(server: Server): Promise<void> {
      server.child.kill("SIGINT");
      assert.equal(await server.closed, 0, server.errors());
      assert.equal(await stat(socket).then(() => true, () => false), false,
        "Shutdown must release the real coordinator's socket");
    }
    async function stopObservedConversation(probe: StopProbe): Promise<void> {
      const { conversation_id: stoppedConversation, entry_id: stoppedEntry, input_id: stoppedInput,
        steer_id: steerInput, queued_id: queuedInput } = probe;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const channel = createConnection({ path: socket, signal: controller.signal });
      const events: RuntimeEventKind[] = [];
      let interrupted = false;
      try {
        // Queue IDs are absent from the attachment, as with messages admitted
        // after opening the view. Their terminal receipts must arrive live.
        const request: RuntimeCommand = probe.root ? { type: "observe_main", input_ids: [stoppedInput] }
          : { type: "attach_conversation", conversation_id: stoppedConversation, input_ids: [stoppedInput] };
        channel.write(JSON.stringify(request) + "\n");
        for await (const line of protocolLines(channel)) {
          const event: unknown = JSON.parse(line), frame = { version: 1, id: 1, event };
          assert.ok(validEvent(frame)); events.push(frame.event);
          if ((frame.event.type === "conversation_ready" || frame.event.type === "main_ready") && !interrupted) {
            interrupted = true;
            const control = createConnection({ path: socket, signal: controller.signal });
            try {
              control.write(JSON.stringify({ type: "conversation_interrupt", conversation_id: stoppedConversation } satisfies RuntimeCommand) + "\n");
              for await (const response of protocolLines(control)) {
                const value: unknown = JSON.parse(response), reply = { version: 1, id: 1, event: value };
                assert.ok(validEvent(reply)); assert.notEqual(reply.event.type, "failure", JSON.stringify(reply.event));
                if (reply.event.type === "done") break;
              }
            } finally { control.destroy(); }
          }
          const rejected = events.filter((event) => event.type === "input_rejected").map((event) => event.input_id);
          const placed = events.some((event) => event.type === "input_placed" && event.input_id === stoppedInput && event.entry_id === stoppedEntry);
          const stopped = events.some((event) => event.type === "input_accepted" && event.input_id === stoppedInput && event.work?.type === "stopped");
          if (placed && stopped && rejected.includes(steerInput) && rejected.includes(queuedInput)) {
            assert.deepEqual(rejected.sort(), [steerInput, queuedInput].sort(), "Each unplaced input receives one terminal receipt");
            assert.equal(events.some((event) => event.type === "host_call"), false, "Observation must not execute effects");
            return;
          }
        }
        assert.fail("Observation ended before stopped input receipts arrived");
      } catch (error) {
        if (controller.signal.aborted) assert.fail("The continuously attached observer did not receive stop receipts: " + JSON.stringify(events));
        throw error;
      } finally { clearTimeout(timeout); channel.destroy(); }
    }
    async function nativeClient(server: Server, restartDelayMs: number): Promise<Server> {
      const project = fileURLToPath(new URL("../../../ios", import.meta.url));
      const scratch = fileURLToPath(new URL("../../../target/native-client-integration", import.meta.url));
      const restart = join(directory, "native-restart-requested"), reconnecting = join(directory, "native-reconnecting");
      const restartReady = join(directory, "native-restart-ready");
      await rm(restart, { force: true }); await rm(reconnecting, { force: true }); await rm(restartReady, { force: true });
      const child = spawn("/usr/bin/xcrun", ["--sdk", "macosx", "swift", "test", "--package-path", project,
        "--scratch-path", scratch, "--filter", "nativeClientReconcilesAgainstTheProductionCoordinator"], {
        detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: directory, TMPDIR: directory,
          AGENT_E2E_SOCKET: socket, AGENT_E2E_DIRECTORY: directory,
          AGENT_E2E_INPUT: input, AGENT_E2E_ENTRY: entry, AGENT_E2E_TEXT: text,
          AGENT_E2E_RESTART_REQUEST: restart, AGENT_E2E_RECONNECTING: reconnecting,
          AGENT_E2E_RESTART_READY: restartReady },
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("close", resolve); child.once("error", reject);
      });
      void closed.catch(() => {});
      const pid = child.pid;
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (value: string) => { output += value; });
      child.stderr.setEncoding("utf8").on("data", (value: string) => { output += value; });
      const stopClient = () => {
        if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try { process.kill(-pid, "SIGTERM"); } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
      };
      const untilSignal = async (path: string) => {
        while (!await stat(path).then(() => true, () => false)) {
          assert.equal(child.exitCode, null, output);
          assert.equal(child.signalCode, null, output);
          t.signal.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      t.signal.addEventListener("abort", stopClient, { once: true });
      try {
        await untilSignal(restart);
        await stop(server);
        // Keep the same native session and its composer alive while the real
        // service is absent. Restart only once that client observes the loss.
        await untilSignal(reconnecting);
        // One real outage exceeds the former 20-second client check. Recovery
        // must be measured from service readiness, not from this setup delay.
        await delay(restartDelayMs, undefined, { signal: t.signal });
        const restarted = await start();
        await writeFile(restartReady, "");
        assert.equal(await closed, 0, output + restarted.errors());
        return restarted;
      } finally {
        t.signal.removeEventListener("abort", stopClient);
        stopClient();
        await closed.catch(() => {});
      }
    }
    for (let run = 0; run < 2; run += 1) {
      let server = await start();
      if (run === 0) for (const probe of stopProbes) await stopObservedConversation(probe);
      for (let reconnect = 0; reconnect < 2; reconnect += 1) {
        const events = await observe();
        const placed = events.findIndex((event) => event.type === "input_placed" && event.input_id === input);
        const history = events.findIndex((event) => event.type === "history");
        assert.ok(placed >= 0 && history > placed,
          "Durable placement must reconcile the pending copy before history becomes ready");
        const messages = events.flatMap((event) => event.type === "history" ? event.messages : []);
        assert.deepEqual(messages.filter((message) => message.text === text).map((message) => message.entry_id), [entry]);
        assert.equal(events.some((event) => event.type === "activity" || event.type === "host_call"), false,
          "Observing an interrupted input must never restart inference or host effects");
      }
      // macOS CI also runs the actual Swift session, outbox and reducer against
      // this same coordinator. Linux exercises the production wire path above.
      if (process.platform === "darwin") server = await nativeClient(server, run === 0 ? 22_000 : 0);
      await stop(server);
    }
  } finally {
    for (const server of children) {
      if (server.child.pid !== undefined && server.child.exitCode === null && server.child.signalCode === null) {
        try { process.kill(-server.child.pid, "SIGTERM"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await server.closed.catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
});
