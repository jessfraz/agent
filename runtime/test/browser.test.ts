import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BrowserStore, createBrowserTools } from "../src/browser.js";
import type { BrowserRequest } from "../src/generated/BrowserRequest.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import { Executions } from "../src/tools.js";

const hostId = "11111111-1111-4111-8111-111111111111";
const otherHostId = "22222222-2222-4222-8222-222222222222";
const host = { host_id: hostId, name: "fixture", rex_server: null, coordinator: null, cwd: "/example/project", agent_program: "/example/agent" };

async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(database), { models, registry }, BACKGROUND_CONTEXT);
  const browsers = new BrowserStore(session), executions = new Executions();
  const tools = createBrowserTools(browsers, executions); registry.install(tools);
  return { session, browsers, executions, tools, faux };
}

function request(command: HostCommand): BrowserRequest {
  assert.equal(command.type, "browser");
  if (command.type !== "browser") throw new Error("Expected a browser operation");
  assert.equal(command.host_id, hostId);
  return command.request;
}

function ready(operation: BrowserRequest, output = "Observed fixture state"): HostResult {
  return { type: "browser", response: { type: "ready", session_id: operation.session_id,
    tabs: [{ id: 7, title: "Fixture", url: "https://example.com/" }], output, is_error: false } };
}

function lastResult(context: TranscriptContext): unknown {
  const message = context.messages.findLast((message) => message.role === "toolResult");
  assert.ok(message?.role === "toolResult");
  return JSON.parse(message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
}

test("browser intent precedes the host effect and an uncertain action survives reopen without replay or host transfer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-store-")); let app = await open(directory);
  const owner = randomUUID(); let calls = 0;
  try {
    const opened = await app.browsers.perform(owner, { type: "open", url: "https://example.com/" }, "open-one", async (command) => {
      const operation = request(command); calls += 1;
      const saved = await app.browsers.binding(owner);
      assert.equal(saved?.pending_operation, "open-one");
      assert.equal(saved.session_id, operation.session_id);
      assert.equal(operation.owner_id, owner);
      return ready(operation, "PRIVATE_PAGE_FIXTURE");
    }, hostId);
    assert.equal(opened.response?.type, "ready");
    const saved = await app.browsers.binding(owner);
    assert.ok(saved?.response?.type === "ready");
    assert.equal(saved.response.output, "", "Page content belongs in Pi's tool entry rather than a second document transcript");
    await assert.rejects(app.browsers.perform(owner, { type: "open", url: "https://example.com/duplicate" }, "duplicate", async () => {
      throw new Error("A second browser must not open");
    }, otherHostId), /already owns/);
    const lost = await app.browsers.perform(owner, { type: "click", tab_id: 7, element_ref: "7_3" }, "submit-one", async (command) => {
      assert.equal(request(command).session_id, opened.session_id); calls += 1;
      throw new Error("The fixture server committed the form before the reply was lost");
    });
    assert.equal(lost.response?.type, "uncertain");
    assert.equal(lost.pending_operation, "submit-one");
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.equal((await app.browsers.binding(owner))?.pending_operation, "submit-one");
    await assert.rejects(app.browsers.perform(owner, { type: "click", tab_id: 7, element_ref: "7_3" }, "submit-again", async () => {
      throw new Error("Uncertain submissions must not be replayed");
    }), /no receipt/);
    const observed = await app.browsers.perform(owner, { type: "status" }, "inspect", async (command) => {
      const operation = request(command); calls += 1;
      assert.equal(operation.session_id, opened.session_id);
      assert.equal(operation.action.type, "status");
      return ready(operation);
    });
    assert.equal(observed.pending_operation, null);
    assert.ok(observed.response?.type === "ready");
    assert.match(observed.response.output, /submit-one.*not replayed/);
    assert.equal(calls, 3);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent browser calls serialize per owner while another conversation progresses independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-concurrency-")); const app = await open(directory);
  let finish: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const owner = randomUUID(), otherOwner = randomUUID();
  try {
    const first = app.browsers.perform(owner, { type: "open", url: "https://example.com/" }, "first", async (command) => {
      entered?.(); await held; return ready(request(command));
    }, hostId);
    await started;
    await assert.rejects(app.browsers.perform(owner, { type: "status" }, "competing", async () => {
      throw new Error("A competing call must not reach Chrome");
    }), /in progress/);
    const independent = await app.browsers.perform(otherOwner, { type: "open", url: "https://example.com/other" }, "independent", async (command) => ready(request(command)), hostId);
    assert.notEqual(independent.session_id, (await app.browsers.binding(owner))?.session_id);
    finish?.(); await first;
  } finally { finish?.(); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("real Pi browser tools retain their host, reject worker overrides, and release only their connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-tools-")); const app = await open(directory);
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools] }, BACKGROUND_CONTEXT);
    const effects: BrowserRequest[] = [];
    const unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], default_host: host, role: "worker",
      call: async (command) => {
        const operation = request(command); effects.push(operation);
        return operation.action.type === "release" ? { type: "browser", response: {
          type: "closed", session_id: operation.session_id, tabs: [], output: "Closed owned fixture tab" } } : ready(operation);
      } });
    let failure: unknown;
    try {
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("browser_open", { url: "https://example.com/", host: "another-host" }), { stopReason: "toolUse" }),
        async (context) => {
          try {
            const result = context.messages.findLast((message) => message.role === "toolResult"); assert.ok(result?.role === "toolResult" && result.isError);
            assert.equal(effects.length, 0);
          } catch (error) { failure = error; }
          return fauxAssistantMessage(fauxToolCall("browser_open", { url: "https://example.com/" }), { stopReason: "toolUse" });
        },
        async (context) => {
          try {
            const result = lastResult(context);
            assert.ok(typeof result === "object" && result !== null && "host_id" in result && result.host_id === hostId);
            assert.equal(effects[0]?.owner_id, root.id.toString());
          } catch (error) { failure = error; }
          return fauxAssistantMessage(fauxToolCall("browser_action", { action: { type: "snapshot", tab_id: 7 } }), { stopReason: "toolUse" });
        },
        fauxAssistantMessage(fauxToolCall("browser_release", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Fixture browser work completed."),
      ]);
      const result = await (await root.submit({ type: "input", content: "Inspect the fixture page, then release its browser connection." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      assert.equal(result.status, "done");
      if (failure !== undefined) throw failure;
      assert.deepEqual(effects.map((operation) => operation.action.type), ["open", "snapshot", "release"]);
      assert.ok(effects.every((operation) => operation.session_id === effects[0]?.session_id));
      assert.equal((await app.browsers.binding(root.id.toString()))?.response?.type, "closed");
    } finally { unbind(); }
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a real Pi turn automatically releases disposable browser tabs after its final answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-yield-")); const app = await open(directory);
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools] }, BACKGROUND_CONTEXT);
    const effects: BrowserRequest[] = [];
    const unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], default_host: host,
      call: async (command) => {
        const operation = request(command); effects.push(operation);
        return operation.action.type === "release" ? { type: "browser", response: {
          type: "closed", session_id: operation.session_id, tabs: [], output: "Closed disposable fixture tab" } } : ready(operation);
      } });
    try {
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("browser_open", { url: "https://example.com/" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("The fixture page was inspected."),
      ]);
      const result = await (await root.submit({ type: "input", content: "Inspect the fixture page." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      assert.equal(result.status, "done");
      assert.deepEqual(effects.map((operation) => operation.action.type), ["open", "release"]);
      assert.equal((await app.browsers.binding(root.id.toString()))?.response?.type, "closed");
    } finally { unbind(); }
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("main browser tools do not silently use a different connected host when their default host is offline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-offline-")); const app = await open(directory);
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools] }, BACKGROUND_CONTEXT);
    let effects = 0;
    const unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], default_host: null,
      call: async (command) => { effects++; return ready(request(command)); } });
    try {
      let failure: unknown;
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("browser_open", { url: "https://example.com/" }), { stopReason: "toolUse" }),
        async (context) => {
          try { const result = context.messages.findLast((message) => message.role === "toolResult"); assert.ok(result?.role === "toolResult" && result.isError); }
          catch (error) { failure = error; }
          return fauxAssistantMessage("Choose an online host explicitly.");
        },
      ]);
      assert.equal((await (await root.submit({ type: "input", content: "Inspect the fixture page." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
      if (failure !== undefined) throw failure;
      assert.equal(effects, 0);
      assert.equal(await app.browsers.binding(root.id.toString()), undefined);
    } finally { unbind(); }
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("a rejected browser action preserves its live connection and still cleans up on yield", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-rejection-")); const app = await open(directory);
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [app.tools] }, BACKGROUND_CONTEXT);
    const effects: BrowserRequest[] = [];
    const unbind = app.executions.bind(root.id.toString(), { cwd: host.cwd, hosts: [host], default_host: host,
      call: async (command) => {
        const operation = request(command); effects.push(operation);
        if (operation.action.type === "close_tab") return { type: "browser", response: { type: "failed", session_id: operation.session_id, message: "This tab is not owned by this connection" } };
        if (operation.action.type === "release") return { type: "browser", response: { type: "closed", session_id: operation.session_id, tabs: [], output: "Released" } };
        return ready(operation);
      } });
    let failure: unknown;
    try {
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("browser_open", { url: "https://example.com/" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("browser_action", { action: { type: "close_tab", tab_id: 999 } }), { stopReason: "toolUse" }),
        async () => {
          try {
            await assert.rejects(app.browsers.perform(root.id.toString(), { type: "open", url: "https://example.com/another" }, "must-not-replace", async () => {
              throw new Error("A rejected action must not replace a live connection");
            }, hostId), /already owns/);
          } catch (error) { failure = error; }
          return fauxAssistantMessage("The invalid tab was preserved.");
        },
      ]);
      assert.equal((await (await root.submit({ type: "input", content: "Inspect the page, then attempt the invalid tab action." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
      if (failure !== undefined) throw failure;
      assert.deepEqual(effects.map((operation) => operation.action.type), ["open", "close_tab", "release"]);
      assert.ok(effects.every((operation) => operation.session_id === effects[0]?.session_id));
    } finally { unbind(); }
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
