import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEventKind } from "../src/generated/RuntimeEventKind.js";
import { protocolLines, validEvent } from "../src/protocol.js";

type Server = { child: ChildProcessWithoutNullStreams; closed: Promise<number | null>; errors(): string };

test("production coordinator reconciles saved input before history across a real socket and restart", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp("/tmp/agent-observation-e2e-");
  const state = join(directory, "state"), bin = join(directory, "bin"), socket = join(state, "agent.sock");
  const input = "11111111-1111-4111-8111-111111111111", text = "Keep the original saved request.";
  const binary = process.env.AGENT_TEST_BINARY ?? fileURLToPath(new URL("../../../target/debug/agent", import.meta.url));
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
    const harness = await Harness.open(await SqliteStorage.open(database),
      { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
    let entry: string;
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      entry = await root.commit(async (tx) => {
        const saved = await tx.appendEntry(UserEntry, root.id,
          { model: [{ role: "user", content: text, timestamp: 1 }] });
        await tx.createSubmission({ type: "input", conversationId: root.id,
          requestId: input, status: "unanswered", entry: saved.id, reason: "aborted" });
        return saved.id.toString();
      }, BACKGROUND_CONTEXT);
    } finally { await harness.close(BACKGROUND_CONTEXT); }

    async function start() {
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
      while (!await stat(socket).then((value) => value.isSocket(), () => false)) {
        assert.equal(child.exitCode, null, stderr);
        t.signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return owned;
    }
    async function observe(): Promise<RuntimeEventKind[]> {
      const channel = createConnection({ path: socket, signal: t.signal });
      const request: RuntimeCommand = { type: "observe_main", input_ids: [input] };
      const events: RuntimeEventKind[] = [];
      try {
        channel.write(JSON.stringify(request) + "\n");
        for await (const line of protocolLines(channel)) {
          const event: unknown = JSON.parse(line), frame = { version: 1, id: 1, event };
          assert.ok(validEvent(frame), "The production server must emit its Rust-owned wire schema");
          events.push(frame.event);
          if (frame.event.type === "worker_idle") return events;
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
    async function nativeClient(server: Server): Promise<Server> {
      const project = fileURLToPath(new URL("../../../ios", import.meta.url));
      const scratch = fileURLToPath(new URL("../../../target/native-client-integration", import.meta.url));
      const restart = join(directory, "native-restart-requested"), reconnecting = join(directory, "native-reconnecting");
      await rm(restart, { force: true }); await rm(reconnecting, { force: true });
      const child = spawn("/usr/bin/xcrun", ["--sdk", "macosx", "swift", "test", "--package-path", project,
        "--scratch-path", scratch, "--filter", "nativeClientReconcilesAgainstTheProductionCoordinator"], {
        detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: directory, TMPDIR: directory,
          AGENT_E2E_SOCKET: socket, AGENT_E2E_DIRECTORY: directory,
          AGENT_E2E_INPUT: input, AGENT_E2E_ENTRY: entry, AGENT_E2E_TEXT: text,
          AGENT_E2E_RESTART_REQUEST: restart, AGENT_E2E_RECONNECTING: reconnecting },
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
        const restarted = await start();
        await observe();
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
      if (process.platform === "darwin") server = await nativeClient(server);
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
