import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CoordinatorEnvironment } from "../../src/environment.js";
import { createGuidance } from "../../src/guidance.js";
import { ConversationModels } from "../../src/models.js";
import { SourceJournal } from "../../src/sources.js";
import { TaskStore, type HostCall } from "../../src/tasks.js";
import { createAppTools, Executions } from "../../src/tools.js";
import type { AgentNode } from "../../src/generated/AgentNode.js";
import type { HostCommand } from "../../src/generated/HostCommand.js";
import type { HostResult } from "../../src/generated/HostResult.js";
import type { ScheduledOccurrence } from "../../src/generated/ScheduledOccurrence.js";
import type { WorkerRef } from "../../src/generated/WorkerRef.js";
import { exampleJob, START, type FakeClock } from "./background-runtime.js";
import { fixtureModel } from "../model.js";

export const scheduledOccurrence: ScheduledOccurrence = { id: "example-occurrence", job: exampleJob(), schedule_id: "daily", scheduled_at: START };
export const node: AgentNode = { host_id: "11111111-1111-4111-8111-111111111111", name: "fixture",
  rex_server: null, agent_program: "/fixture/agent", home_directory: "/workspace/example", coordinator: null,
  launch: { state_dir: null, runtime: null, config: null, instructions: null, model: fixtureModel } };
export const binding: WorkerRef = { host_id: node.host_id, session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };

export async function openScheduled(directory: string, guidanceVersion = "original", clock?: FakeClock) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }, { id: "fixture-updated" }], tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(database), { models, registry,
    ...(clock === undefined ? {} : { now: clock.now, setTimer: clock.setTimer }),
    identity: { attribution: null }, settings: { retry: { enabled: false } } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models));
  const environment = new CoordinatorEnvironment(session); environment.useLiveGuidance(); tasks.useEnvironment(environment);
  await environment.configure({ node, settings: { model: fixtureModel, instructions: "Current global policy.", context_repositories: [], sources: [] } });
  environment.setConnected([node.host_id]);
  const executions = new Executions(), tools = createAppTools(tasks, executions), guidance = createGuidance(executions);
  await executions.prepareRecovery(session);
  registry.install(guidance); registry.install(tools.host); registry.install(tools.main); registry.install(tools.worker);
  const sources = new SourceJournal(session, tasks, executions);
  const commands: HostCommand[] = [];
  const call = async (command: HostCommand): Promise<HostResult> => {
    commands.push(command);
    if (command.type === "spawn_worker" || command.type === "resume_worker") return { type: "spawned", binding };
    if (command.type === "reload_guidance") return { type: "shared_guidance", global: { text: "FRESH_GLOBAL_POLICY", sources: [] },
      workflow_policy: "Current execution policy.", context_repositories: [], context_sources: [] };
    if (command.type === "project_guidance") return { type: "project_guidance", snapshot: { text: `FRESH_PROJECT_POLICY_${guidanceVersion}`, sources: [] } };
    if (command.type === "exec") return { type: "process", exit_code: 0, stdout: "owned host tool output", stderr: "", truncated: false };
    if (command.type === "read_file") return { type: "file", content: await readFile(command.path, "utf8"), truncated: false };
    return { type: "failed", message: "The fixture received an unsupported host command" };
  };
  async function worker(taskId: string, controller = new AbortController(), hostCall: HostCall = call, interactive = false) {
    const task = await tasks.get(taskId);
    if (task.worker.state !== "bound") throw new Error("The scheduled fixture has no bound worker");
    return tasks.run({ type: "run_task", task_id: task.id, allocation_id: task.worker.allocation_id, binding: task.worker.binding,
      model: fixtureModel, cwd: task.worker.host.cwd, instructions: "", interactive },
    (conversation, host, model) => executions.bind(conversation.id.toString(), { cwd: host.cwd, hosts: [host], role: "worker", model, call: hostCall }), [guidance, tools.host, tools.worker], hostCall, undefined,
    { signal: controller.signal, async ready() {}, answer() {}, idle() {} });
  }
  return { session, tasks, sources, environment, call, commands, faux, executions, worker, registry };
}
