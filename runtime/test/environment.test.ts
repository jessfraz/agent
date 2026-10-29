import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CoordinatorEnvironment } from "../src/environment.js";
import { createGuidance } from "../src/guidance.js";
import { ConversationModels } from "../src/models.js";
import { ResourceStore } from "../src/resources.js";
import { TaskStore } from "../src/tasks.js";
import { createAppTools, Executions, HostRequests } from "../src/tools.js";
import type { AgentNode } from "../src/generated/AgentNode.js";
import type { CoordinatorSettings } from "../src/generated/CoordinatorSettings.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import type { MachineSnapshot } from "../src/generated/MachineSnapshot.js";
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
  return { session, environment, tasks, executions, tools, inference, faux, registry };
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

test("machine refresh probes only online hosts concurrently and preserves sampled values and unknown coverage across SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-machines-")); let app = await open(directory);
  const sample: MachineSnapshot = { observed_at_ms: 1000, os: "linux", architecture: "x86_64", logical_cpus: 8,
    memory_total_bytes: 32 * 1024 ** 3, memory_available_bytes: 16 * 1024 ** 3, load_average: [1, 0.5, 0.25], tailscale_ip: "100.64.0.10" };
  const server: AgentNode = { ...coordinator, host_id: "33333333-3333-4333-8333-333333333333", name: "server", machine: sample };
  const legacy: AgentNode = { ...coordinator, host_id: "44444444-4444-4444-8444-444444444444", name: "legacy" };
  try {
    await app.environment.configure({ settings, node: { ...coordinator, machine: sample } });
    await app.environment.register({ ...laptop, machine: sample }); await app.environment.register(server); await app.environment.register(legacy);
    app.environment.setConnected([coordinator.host_id, laptop.host_id, legacy.host_id]);
    const calls: string[] = [];
    let entered = () => {}, release = () => {};
    const began = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const refresh = app.environment.environment(async (command) => {
      assert.ok(command.type === "on_node" && command.command.type === "machine_snapshot");
      calls.push(command.host_id); if (calls.length === 2) entered(); await held;
      return command.host_id === coordinator.host_id ? { type: "machine_snapshot", snapshot: sample } : { type: "failed", message: "Synthetic disconnected probe" };
    });
    await began;
    assert.deepEqual(new Set(calls), new Set([coordinator.host_id, laptop.host_id]));
    const before = await app.environment.environment();
    assert.deepEqual(before.nodes.find((node) => node.host_id === coordinator.host_id)?.machine, sample, "Ordinary reads do not await or run probes");
    release(); const result = await refresh;
    assert.deepEqual(result.nodes.find((node) => node.host_id === coordinator.host_id)?.machine, sample);
    assert.deepEqual(result.nodes.find((node) => node.host_id === server.host_id)?.machine, sample);
    assert.deepEqual(result.unavailable_host_ids, [laptop.host_id, legacy.host_id]);
    assert.deepEqual(result.nodes.find((node) => node.host_id === laptop.host_id)?.machine, sample);
    assert.equal(result.nodes.find((node) => node.host_id === legacy.host_id)?.machine, undefined);
    await app.environment.register(coordinator); // Older clients may register without telemetry.
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    const saved = await app.environment.environment();
    assert.deepEqual(saved.online_host_ids, []);
    assert.deepEqual(saved.nodes.find((node) => node.host_id === coordinator.host_id)?.machine, sample);
    assert.deepEqual(saved.nodes.find((node) => node.host_id === server.host_id)?.machine, sample);
    assert.equal((await app.tasks.list()).length, 0); assert.equal(app.faux.state.callCount, 0);
    app.environment.setConnected([coordinator.host_id]);
    const downgraded = await app.environment.environment(async () => { assert.fail("An older worker must not receive an unsupported native host command"); });
    assert.deepEqual(downgraded.unavailable_host_ids, [coordinator.host_id]);
    assert.deepEqual(downgraded.nodes.find((node) => node.host_id === coordinator.host_id)?.machine, sample);
    await app.environment.register({ ...coordinator, machine: sample });
    let releaseOld = () => {}, oldStarted = () => {};
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; }), oldBegan = new Promise<void>((resolve) => { oldStarted = resolve; });
    const old = app.environment.environment(async () => { oldStarted(); await oldGate; return { type: "machine_snapshot", snapshot: { ...sample, observed_at_ms: 2000 } }; });
    await oldBegan;
    await app.environment.environment(async () => ({ type: "machine_snapshot", snapshot: { ...sample, observed_at_ms: 3000 } }));
    releaseOld(); await old;
    assert.equal((await app.environment.environment()).nodes.find((node) => node.host_id === coordinator.host_id)?.machine?.observed_at_ms, 3000, "A late older probe cannot overwrite a newer observation");
    await app.environment.register({ ...coordinator, agent_program: "/nix/store/updated/bin/agent", machine: sample });
    const registered = (await app.environment.environment()).nodes.find((node) => node.host_id === coordinator.host_id);
    assert.equal(registered?.machine?.observed_at_ms, 3000, "A delayed registration cannot overwrite a newer machine observation");
    assert.equal(registered?.agent_program, "/nix/store/updated/bin/agent", "Registration still refreshes deployment metadata");
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

test("main chat keeps its Pi history and coordinator default while a laptop disconnects and returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-environment-offline-")); let app = await open(directory);
  let resources = new ResourceStore(app.session, app.tasks);
  app.tasks.guardResources(resources);
  const commands: HostCommand[] = [];
  const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const latest = (context: TranscriptContext) => {
    const result = context.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult"); return result;
  };
  const call = async (command: HostCommand): Promise<HostResult> => {
    commands.push(command);
    if (command.type === "reload_guidance") return { type: "shared_guidance", global: { text: "Use current synthetic global guidance.", sources: [] },
      context_repositories: settings.context_repositories, context_sources: [], workflow_policy: "Keep existing task ownership." };
    if (command.type === "on_node") {
      const state = await app.environment.environment();
      assert.ok(state.online_host_ids.includes(command.host_id), "No operation may reach the disconnected laptop");
      const node = state.nodes.find((node) => node.host_id === command.host_id); assert.ok(node);
      if (command.command.type === "project_guidance") return { type: "project_guidance", snapshot: { text: `Current project on ${node.name}.`, sources: [] } };
      if (command.command.type === "exec") return { type: "process", exit_code: 0, stdout: node.name, stderr: "", truncated: false };
    }
    if (command.type === "spawn_worker") {
      assert.ok((await app.environment.environment()).online_host_ids.includes(command.host.host_id ?? ""));
      return { type: "spawned", binding: { host_id: command.host.host_id ?? "", session_id: `session:${randomUUID()}`,
        window_id: `window:${randomUUID()}`, block_id: `block:${randomUUID()}` } };
    }
    if (command.type === "resume_worker") {
      assert.ok((await app.environment.environment()).online_host_ids.includes(command.binding.host_id));
      return { type: "written" };
    }
    throw new Error(`Unexpected host operation: ${command.type}`);
  };
  let rootId: string | undefined;
  async function turn(input: string, origin: AgentNode, cwd: string, responses: FauxResponseStep[]): Promise<void> {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    if (rootId === undefined) rootId = root.id.toString(); else assert.equal(root.id.toString(), rootId);
    const hosts = await app.environment.hosts(cwd, origin.host_id, []);
    const default_host = await app.environment.defaultHost(hosts);
    const guidance = createGuidance(app.executions); app.registry.install(guidance);
    app.environment.useLiveGuidance();
    const release = app.executions.bind(root.id.toString(), { model: await app.environment.model(null), cwd, hosts, default_host,
      project: () => call({ type: "on_node", host_id: origin.host_id, command: { type: "project_guidance", cwd } }),
      call: (command) => call(app.environment.route(command, default_host)) });
    try {
      await app.inference.configure(root, await app.environment.model(null), {
        instructions: await app.environment.instructions(""), cwd, extensions: [guidance, app.tools.host, app.tools.main] });
      app.faux.setResponses(responses);
      const settled = await (await root.submit({ type: "input", content: input }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      assert.equal(settled.status, "done"); assert.equal(app.faux.getPendingResponseCount(), 0);
    } finally { release(); }
  }
  const newDefault = (title: string) => tool("delegate_task", { title, outcome: title, input: title, new_task: true, new_task_reason: `${title} is a separate synthetic audit.` });
  try {
    await app.environment.configure({ settings, node: coordinator }); await app.environment.register(laptop);
    app.environment.setConnected([coordinator.host_id, laptop.host_id]);
    const firstInput = "Remember the sapphire connector and inspect the laptop board project.";
    const firstAnswer = "The sapphire connector detail is remembered.";
    await turn(firstInput, laptop, "/home/laptop/project", [
      (context) => { assert.match(getCurrentSystemPrompt(context.messages), /Current project on laptop/); return tool("exec", { program: "inspect", args: [] }); },
      tool("delegate_task", { title: "Sapphire board inspection", outcome: "Verify the sapphire connector", input: "Inspect the sapphire connector.", host: laptop.host_id }),
      newDefault("Initial coordinator audit"), fauxAssistantMessage(firstAnswer),
    ]);
    const old = (await app.tasks.list()).find((task) => task.title === "Sapphire board inspection"); assert.ok(old);
    assert.ok(old.worker.state === "bound"); const original = old.worker;
    app.faux.setResponses([fauxAssistantMessage("Laptop inspection recorded the sapphire connector measurement.")]);
    await app.tasks.run({ type: "run_task", task_id: old.id, allocation_id: original.allocation_id, binding: original.binding,
      instructions: "Inspect the synthetic board.", model: fixtureModel, cwd: original.host.cwd }, () => () => {});
    await app.tasks.enqueue(old.id, "Recheck the connector when the laptop is available.");
    const request = { host_id: laptop.host_id, task_id: old.id, allocation_id: randomUUID(), repository: "/home/laptop/project", branch: "connector-review" };
    await resources.allocate(request, async () => ({ type: "resource", report: { type: "observed", record: {
      id: request.allocation_id, host_id: laptop.host_id, task_id: old.id, repository: request.repository, branch: request.branch, consumers: [],
      state: { state: "ready", identity: { primary: request.repository, top: "/home/laptop/project-review", common_dir: "/home/laptop/project/.git",
        git_dir: "/home/laptop/project/.git/worktrees/review", branch: request.branch, head: "synthetic-head" } },
    } } }));
    const retained = await app.tasks.get(old.id), owned = await resources.list();
    app.environment.setConnected([coordinator.host_id]);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    resources = new ResourceStore(app.session, app.tasks); app.tasks.guardResources(resources);
    app.environment.setConnected([coordinator.host_id]);
    const offlineStart = commands.length;
    await turn("Read the earlier laptop details and do new work here.", coordinator, coordinator.home_directory, [
      (context) => {
        const history = context.messages.filter((message) => message.role === "user" || message.role === "assistant").flatMap((message) =>
          typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
        assert.ok(history.includes(firstInput) && history.includes(firstAnswer));
        assert.match(getCurrentSystemPrompt(context.messages), /Current project on desktop/);
        assert.doesNotMatch(getCurrentSystemPrompt(context.messages), /Current project on laptop/);
        return tool("read_task", { task_id: old.id });
      },
      (context) => {
        const result = latest(context); assert.equal(result.isError, false);
        const decoded: unknown = JSON.parse(result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
        assert.ok(decoded !== null && typeof decoded === "object" && "history" in decoded && typeof decoded.history === "string");
        assert.match(decoded.history, /Laptop inspection recorded the sapphire connector measurement/);
        return tool("exec", { program: "inspect", args: [] });
      },
      newDefault("Offline coordinator audit"),
      tool("delegate_task", { title: "Unavailable laptop task", outcome: "Wait for laptop", input: "Work on the laptop.", host: laptop.host_id, new_task: true,
        new_task_reason: "This is a separate synthetic offline-host validation." }),
      (context) => { assert.equal(latest(context).isError, true); return tool("delegate_task", { task_id: old.id, input: "Do not move this task while offline." }); },
      (context) => { assert.equal(latest(context).isError, true); return fauxAssistantMessage("Coordinator work started; the laptop task is retained."); },
    ]);
    assert.deepEqual(await app.tasks.get(old.id), retained); assert.deepEqual(await resources.list(), owned);
    assert.equal((await app.tasks.list()).length, 3, "Offline requests must not duplicate or relocate the laptop task");
    assert.ok(commands.slice(offlineStart).every((command) => command.type !== "on_node" || command.host_id === coordinator.host_id));
    const currentLaptop: AgentNode = { ...laptop, agent_program: "/nix/store/current-laptop/bin/agent",
      launch: { ...laptop.launch, config: "/home/laptop/current.toml" } };
    await app.environment.register(currentLaptop); app.environment.setConnected([coordinator.host_id, laptop.host_id]);
    await turn("The laptop is back; continue its task and start the requested new work.", coordinator, coordinator.home_directory, [
      tool("exec", { program: "inspect", args: [] }), newDefault("Reconnected coordinator audit"),
      tool("delegate_task", { title: "Reconnected laptop audit", outcome: "Inspect the laptop", input: "Inspect the restored laptop.", host: laptop.host_id, new_task: true,
        new_task_reason: "This is a separate synthetic laptop audit." }),
      tool("delegate_task", { task_id: old.id, input: "Continue the sapphire connector review." }),
      (context) => { assert.equal(latest(context).isError, false); return fauxAssistantMessage("The existing laptop session received the follow-up."); },
    ]);
    const execs = commands.filter((command) => command.type === "on_node" && command.command.type === "exec");
    assert.equal(execs.length, 3);
    for (const command of execs) {
      assert.ok(command.type === "on_node" && command.command.type === "exec");
      assert.equal(command.host_id, coordinator.host_id); assert.equal(command.command.cwd, coordinator.home_directory);
    }
    const spawns = commands.filter((command) => command.type === "spawn_worker");
    assert.deepEqual(spawns.map((command) => command.host.host_id), [laptop.host_id, coordinator.host_id, coordinator.host_id, coordinator.host_id, laptop.host_id]);
    const resumed = commands.filter((command) => command.type === "resume_worker");
    assert.equal(resumed.length, 1); assert.equal(resumed[0]?.task_id, old.id); assert.deepEqual(resumed[0]?.binding, original.binding);
    for (const command of [spawns.at(-1), resumed[0]]) {
      assert.ok(command); assert.equal(command.host.agent_program, currentLaptop.agent_program);
      assert.equal(command.host.launch?.config, currentLaptop.launch.config);
    }
    const continued = await app.tasks.get(old.id); assert.ok(continued.worker.state === "bound");
    assert.equal(continued.conversation_id, old.conversation_id); assert.equal(continued.worker.allocation_id, original.allocation_id);
    assert.deepEqual(continued.worker.binding, original.binding); assert.deepEqual(continued.model, fixtureModel);
    assert.equal(continued.worker.host.cwd, original.host.cwd); assert.equal(continued.pending.length, retained.pending.length + 1);
    assert.deepEqual(continued.pending.slice(0, retained.pending.length), retained.pending); assert.deepEqual(await resources.list(), owned);
    assert.equal((await app.tasks.list()).length, 5);
    assert.ok(rootId); const rootHistory = await app.tasks.readConversation(rootId);
    assert.ok(rootHistory.includes(firstInput) && rootHistory.includes(firstAnswer));
    assert.match(rootHistory, /Coordinator work started; the laptop task is retained/);
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
        fauxAssistantMessage(fauxToolCall("exec", { program: "pwd", args: [], timeout_seconds: 65535 }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("read_context", { repository_id: "operations", path: "playbooks/mail.md" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("search_context", { repository_id: "operations", query: "brief", path: "context", limit: 5 }), { stopReason: "toolUse" }),
        fauxAssistantMessage("The coordinator context and project are available."),
      ]);
      assert.equal((await (await root.submit({ type: "input", content: "Inspect the shared context and this project." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
      assert.deepEqual(commands, [
        { type: "on_node", host_id: coordinator.host_id, command: { type: "exec", program: "pwd", args: [], cwd: coordinator.home_directory, timeout_seconds: 900 } },
        { type: "on_node", host_id: laptop.host_id, command: { type: "exec", program: "pwd", args: [], cwd: "/home/laptop/project", timeout_seconds: 900 } },
        { type: "on_node", host_id: coordinator.host_id, command: { type: "exec", program: "pwd", args: [], cwd: coordinator.home_directory, timeout_seconds: 65535 } },
        { type: "read_context", repository_id: "operations", path: "playbooks/mail.md", offset: 0, limit: 64000 },
        { type: "search_context", repository_id: "operations", query: "brief", path: "context", limit: 5 },
      ]);
    } finally { release(); }
    commands.splice(0);
    const task = await app.tasks.create({ title: "Context worker", outcome: "Use shared context", model: fixtureModel });
    const host = hosts[0]; assert.ok(host);
    await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    await app.tasks.enqueue(task.id, "Use another connected host without moving this task.");
    const saved = await app.tasks.get(task.id); if (saved.worker.state !== "bound") throw new Error("Expected binding");
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("exec", { program: "pwd", args: [], host: laptop.name }), { stopReason: "toolUse" }),
      () => {
        app.environment.setConnected([coordinator.host_id]);
        return fauxAssistantMessage(fauxToolCall("exec", { program: "pwd", args: [], host: laptop.host_id }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("exec", { program: "pwd", args: [] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_context", { repository_id: "operations", path: "context/preferences.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("search_context", { repository_id: "unknown", query: "secret" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Shared context checked."),
    ]);
    await app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: saved.worker.allocation_id, binding,
      instructions: "Project instructions.", model: fixtureModel, cwd: host.cwd }, (conversation) => app.executions.bind(conversation.id.toString(), {
        role: "worker", cwd: host.cwd, hosts: [host], default_host: host,
        connectedHosts: () => app.environment.hosts(host.cwd, host.host_id ?? null, [host]), call,
      }), [app.tools.host, app.tools.worker]);
    assert.deepEqual(commands, [
      { type: "on_node", host_id: laptop.host_id, command: { type: "exec", program: "pwd", args: [], cwd: laptop.home_directory, timeout_seconds: 900 } },
      { type: "exec", program: "pwd", args: [], cwd: host.cwd, timeout_seconds: 900 },
      { type: "read_context", repository_id: "operations", path: "context/preferences.md", offset: 0, limit: 64000 },
    ]);
    assert.match(await app.tasks.history(task.id), /Choose a connected worker host/);
    assert.match(await app.tasks.history(task.id), /Unknown coordinator context repository/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("routed host operations retain long requested deadlines and release their expired replies", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let callId = "";
  const requests = new HostRequests((_request, id) => { callId = id; });
  for (const timeout_seconds of [900,65535]) {
    const operation = requests.call(1, { type: "on_node", host_id: laptop.host_id,
      command: { type: "exec", program: "work", args: [], cwd: "/workspace/example", timeout_seconds } });
    context.mock.timers.tick(timeout_seconds*1000+9999);
    assert.equal(requests.reply(1, callId, { type: "written" }), true, "The complete requested duration and transport grace remain available");
    assert.deepEqual(await operation, { type: "written" });
  }
  const expired=requests.call(2,{type:"on_node",host_id:laptop.host_id,command:{type:"exec",program:"work",args:[],cwd:"/workspace/example",timeout_seconds:1}});
  const rejected=assert.rejects(expired,/did not confirm/);
  context.mock.timers.tick(11000);
  await rejected;
  assert.equal(requests.reply(2,callId,{type:"written"}),false,"A late reply cannot complete an expired operation");
});
