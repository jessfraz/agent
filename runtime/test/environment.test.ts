import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CoordinatorEnvironment } from "../src/environment.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions, HostRequests } from "../src/tools.js";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { CoordinatorSettings } from "../src/generated/CoordinatorSettings.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";
import { fixtureModel } from "./model.js";

const coordinator: AgentNode = { host_id: "11111111-1111-4111-8111-111111111111", name: "desktop",
  rex_server: null, agent_program: "/nix/store/original/bin/agent", home_directory: "/home/desktop",
  coordinator: "tailscale://100.64.0.10", launch: { state_dir: null, runtime: null,
    config: "/home/desktop/agent.toml", instructions: null, model: null } };
const laptop: AgentNode = { ...coordinator, host_id: "22222222-2222-4222-8222-222222222222", name: "laptop",
  home_directory: "/home/laptop", agent_program: "/nix/store/laptop/bin/agent" };
const settings: CoordinatorSettings = { model: fixtureModel, instructions: "Keep answers brief.",
  context_repositories: [{ id: "operations", root: "/home/desktop/operations", instructions: "Follow the owning playbook." }], sources: [] };
const binding: WorkerRef = { host_id: coordinator.host_id, session_id: "session:33333333-3333-4333-8333-333333333333",
  window_id: "window:44444444-4444-4444-8444-444444444444", block_id: "block:55555555-5555-4555-8555-555555555555" };
async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(database), { models, registry,
    identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const inference = new ConversationModels(models); const tasks = new TaskStore(session, inference);
  const environment = new CoordinatorEnvironment(session); tasks.useEnvironment(environment);
  const executions = new Executions(); const tools = createAppTools(tasks, executions);
  registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker);
  return { session, environment, tasks, executions, tools, inference, faux };
}

test("canonical settings and node history survive Pi reopen while online membership does not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-environment-")); let app = await open(directory);
  try {
    await app.environment.configure({ settings, node: coordinator });
    await app.environment.register(laptop); await app.environment.register(laptop);
    app.environment.setConnected([coordinator.host_id, laptop.host_id]);
    const old = await app.tasks.create({ title: "Existing task", outcome: "Preserve its selected model", model: await app.environment.model(null) });
    const hosts = await app.environment.hosts("/home/laptop/project", laptop.host_id, []);
    assert.deepEqual(hosts.map((host) => [host.name, host.cwd]), [["desktop", "/home/desktop"], ["laptop", "/home/laptop/project"]]);
    const selected = { ...fixtureModel, reasoning: "off" } satisfies typeof fixtureModel;
    await app.environment.configure({ settings: { ...settings, model: selected }, node: coordinator });
    assert.deepEqual(await app.environment.model(null), selected);
    assert.deepEqual(await app.environment.model(fixtureModel), fixtureModel);
    assert.deepEqual((await app.tasks.get(old.id)).model, fixtureModel);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const reopened = await app.environment.environment();
    assert.equal(reopened.nodes.length, 2); assert.deepEqual(reopened.online_host_ids, []);
    assert.deepEqual(reopened.settings.model, selected);
    assert.deepEqual(await app.environment.hosts("/home/laptop/project", laptop.host_id, hosts), [], "Cached nodes never become executable merely because metadata exists");
    app.environment.setConnected([laptop.host_id]);
    const connected = await app.environment.hosts("/home/laptop/project", laptop.host_id, []);
    const defaultHost = await app.environment.defaultHost(connected);
    assert.equal(defaultHost, null);
    assert.throws(() => app.environment.route({ type: "exec", program: "pwd", args: [], cwd: "/home/laptop/project", timeout_seconds: 1 }, defaultHost), /coordinator execution host is offline/);
    assert.equal(connected[0]?.host_id, laptop.host_id, "The caller can still explicitly target its connected node");
    await assert.rejects(app.environment.register({ ...laptop, host_id: "66666666-6666-4666-8666-666666666666", name: "DESKTOP" }), /one native Rex host/);
    assert.equal((await app.environment.environment()).nodes.length, 2);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("task resume refreshes node deployment without moving its cwd, model, session or history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-environment-")); let app = await open(directory);
  try {
    await app.environment.configure({ settings, node: coordinator }); app.environment.setConnected([coordinator.host_id]);
    const host = (await app.environment.hosts("/ignored/client/project", null, []))[0]; assert.ok(host);
    const task = await app.tasks.create({ title: "Continue change", outcome: "Finish the original work", model: fixtureModel });
    await app.tasks.enqueue(task.id, "Preserve the original pending assignment.");
    await app.tasks.dispatch(task.id, { ...host, cwd: "/home/desktop/project" }, async () => ({ type: "spawned", binding }));
    const conversation = await app.tasks.conversation(task.conversation_id);
    await conversation.submit({ type: "write", entry: { kind: "fixture.history", model: [
      { role: "user", content: "The original sapphire connector evidence.", timestamp: Date.now() },
    ] } }, BACKGROUND_CONTEXT);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    let effects = 0;
    await assert.rejects(app.tasks.dispatch(task.id, host, async () => { effects += 1; return { type: "spawned", binding }; }), /offline/);
    assert.equal(effects, 0); assert.equal((await app.tasks.get(task.id)).worker.state, "bound");
    const updated: AgentNode = { ...coordinator, name: "renamed desktop", agent_program: "/nix/store/current/bin/agent",
      launch: { ...coordinator.launch, config: "/home/desktop/current.toml", model: { ...fixtureModel, reasoning: "off" } } };
    await app.environment.register(updated); app.environment.setConnected([coordinator.host_id]);
    const resumed = await app.tasks.dispatch(task.id, host, async (command) => {
      assert.equal(command.type, "resume_worker"); if (command.type !== "resume_worker") throw new Error("Expected resume");
      effects += 1; assert.equal(command.host.agent_program, updated.agent_program);
      assert.equal(command.host.launch?.config, updated.launch.config); assert.equal(command.host.cwd, "/home/desktop/project");
      assert.deepEqual(command.host.launch?.model, fixtureModel); assert.equal(command.binding.session_id, binding.session_id);
      return { type: "spawned", binding };
    });
    assert.equal(effects, 1); assert.equal(resumed.conversation_id, task.conversation_id); assert.equal(resumed.pending.length, 1);
    assert.match(await app.tasks.history(task.id), /sapphire connector/);
    const child = await app.tasks.createAgent(task.id, { id: "review", inputId: "review-input", title: "Review", outcome: "Review the change", input: "Check the evidence." });
    assert.deepEqual(child.model, fixtureModel);
    await app.tasks.dispatchAgent(task.id, child.id, async (command) => {
      assert.equal(command.type, "spawn_subagent"); if (command.type !== "spawn_subagent") throw new Error("Expected child");
      assert.equal(command.host.agent_program, updated.agent_program); assert.equal(command.parent.session_id, binding.session_id);
      return { type: "spawned", binding: { ...binding, block_id: "block:77777777-7777-4777-8777-777777777777" } };
    });
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native model tools route main execution explicitly and expose coordinator context to workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-environment-")); const app = await open(directory);
  try {
    await app.environment.configure({ settings, node: coordinator }); await app.environment.register(laptop);
    app.environment.setConnected([coordinator.host_id, laptop.host_id]);
    const instructions = await app.tasks.instructions("Project: keep the caller's checkout.");
    assert.match(instructions, /Keep answers brief/); assert.match(instructions, /Follow the owning playbook/);
    assert.match(instructions, /Context repository operations: \/home\/desktop\/operations/);
    assert.match(instructions, /Project: keep the caller's checkout/);
    const hosts = await app.environment.hosts("/home/laptop/project", laptop.host_id, []);
    const default_host = await app.environment.defaultHost(hosts);
    const commands: HostCommand[] = [];
    const call = async (command: HostCommand): Promise<HostResult> => {
      commands.push(command);
      return command.type === "search_context" ? { type: "context_matches", matches: [{ path: "context/preferences.md", line: 3, text: "Brief updates." }], truncated: false }
        : command.type === "read_context" ? { type: "file", content: "Use the owning workflow.", truncated: false }
        : { type: "process", exit_code: 0, stdout: "ok", stderr: "", truncated: false };
    };
    const root = await app.session.root(BACKGROUND_CONTEXT);
    const release = app.executions.bind(root.id.toString(), { model: fixtureModel, cwd: "/home/laptop/project", hosts, default_host,
      call: (command) => call(app.environment.route(command, default_host)) });
    try {
      await app.inference.configure(root, fixtureModel, { instructions, extensions: [app.tools.host, app.tools.main] });
      app.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("exec", { program: "pwd", args: [] }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("exec", { program: "pwd", args: [], host: laptop.host_id }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("read_context", { repository_id: "operations", path: "playbooks/mail.md" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("search_context", { repository_id: "operations", query: "brief", path: "context", limit: 5 }), { stopReason: "toolUse" }),
        fauxAssistantMessage("The coordinator context and project are available."),
      ]);
      assert.equal((await (await root.submit({ type: "input", content: "Inspect the shared context and this project." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
      assert.deepEqual(commands, [
        { type: "on_node", host_id: coordinator.host_id, command: { type: "exec", program: "pwd", args: [], cwd: coordinator.home_directory, timeout_seconds: 300 } },
        { type: "on_node", host_id: laptop.host_id, command: { type: "exec", program: "pwd", args: [], cwd: "/home/laptop/project", timeout_seconds: 300 } },
        { type: "read_context", repository_id: "operations", path: "playbooks/mail.md", offset: 0, limit: 64000 },
        { type: "search_context", repository_id: "operations", query: "brief", path: "context", limit: 5 },
      ]);
    } finally { release(); }
    commands.splice(0);
    const task = await app.tasks.create({ title: "Context worker", outcome: "Use shared context", model: fixtureModel });
    const host = hosts[0]; assert.ok(host);
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    await app.tasks.enqueue(task.id, "Check context without changing execution hosts.");
    const saved = await app.tasks.get(task.id); if (saved.worker.state !== "bound") throw new Error("Expected binding");
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("exec", { program: "pwd", args: [], host: laptop.name }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_context", { repository_id: "operations", path: "context/preferences.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("search_context", { repository_id: "unknown", query: "secret" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Shared context checked."),
    ]);
    await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id, binding,
      instructions: "Project instructions.", model: fixtureModel, cwd: host.cwd }, (conversation) => app.executions.bind(conversation.id.toString(), {
        role: "worker", cwd: host.cwd, hosts: [host], call,
      }), () => {}, [app.tools.host, app.tools.worker]);
    assert.deepEqual(commands, [{ type: "read_context", repository_id: "operations", path: "context/preferences.md", offset: 0, limit: 64000 }]);
    assert.match(await app.tasks.history(task.id), /Task commands run on their owning host/);
    assert.match(await app.tasks.history(task.id), /Unknown coordinator context repository/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("routed host operations retain the native operation deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let callId = "";
  const requests = new HostRequests((_request, id) => { callId = id; });
  const operation = requests.call(1, { type: "on_node", host_id: laptop.host_id,
    command: { type: "exec", program: "work", args: [], cwd: "/workspace/example", timeout_seconds: 300 } });
  context.mock.timers.tick(30_001);
  assert.equal(requests.reply(1, callId, { type: "written" }), true, "Wrapping a command must not shorten its deadline to thirty seconds");
  assert.deepEqual(await operation, { type: "written" });
});
