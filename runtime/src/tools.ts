import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineExtension, defineTool, ROOT_CONVERSATION_ID, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { DEFAULT_MODEL } from "./models.js";
import type { ModelSelection } from "./generated/ModelSelection.js";
import type { HostCommand } from "./generated/HostCommand.js";
import type { HostResult } from "./generated/HostResult.js";
import type { WorkerHost } from "./generated/WorkerHost.js";
import { TaskError, TaskStore, type HostCall } from "./tasks.js";

export type Execution = { model?: ModelSelection; cwd: string; hosts: WorkerHost[]; default_host?: WorkerHost | null; call: HostCall; role?: "worker" | "triage";
  notify?: (task: string | null, text: string) => void };
/** A conversation can execute only through its currently attached CLI client. */
export class Executions {
  private readonly attached = new Map<string, Execution>();
  bind(id: string, execution: Execution): () => void {
    if (this.attached.has(id)) throw new TaskError("This conversation already has an execution client");
    this.attached.set(id, execution);
    return () => { if (this.attached.get(id) === execution) this.attached.delete(id); };
  }
  get(id: string): Execution {
    const execution = this.attached.get(id);
    if (execution === undefined) throw new TaskError("The execution client is disconnected; attach the task to continue");
    return execution;
  }
}

function output(value: unknown, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) ?? "" }], isError };
}
function hostOutput(result: HostResult) {
  return output(result, result.type === "failed" || result.type === "creation_uncertain" ||
    (result.type === "process" && result.exit_code !== 0));
}
const source = Type.Object({ provider: Type.String(), account: Type.String(), thread_id: Type.String() });
const taskState = Type.Union([
  Type.Object({ state: Type.Literal("open") }),
  Type.Object({ state: Type.Literal("waiting"), actor: Type.String({ minLength: 1 }),
    next_check: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ state: Type.Literal("resolved"), evidence: Type.String({ minLength: 1 }) }),
]);

export class HostRequests {
  private readonly pending = new Map<string, {
    request: number; resolve: (value: HostResult) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  constructor(private readonly emit: (request: number, call: string, command: HostCommand) => void) {}
  call(request: number, command: HostCommand): Promise<HostResult> {
    if (this.pending.size >= 128) return Promise.reject(new TaskError("Too many pending host operations"));
    const call = randomUUID();
    return new Promise<HostResult>((resolve, reject) => {
      let operation = command;
      while (operation.type === "on_node") operation = operation.command;
      const timeout = operation.type === "exec" ? operation.timeout_seconds * 1000 + 10_000
        : operation.type.startsWith("resource_") ? 310_000 : 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(call);
        reject(new TaskError("The execution client did not confirm the operation; inspect its state before retrying"));
      }, timeout);
      this.pending.set(call, { request, resolve, reject, timer });
      try { this.emit(request, call, command); }
      catch {
        clearTimeout(timer);
        this.pending.delete(call);
        reject(new TaskError("The execution client could not be reached"));
      }
    });
  }
  reply(request: number, call: string, result: HostResult): boolean {
    const pending = this.pending.get(call);
    if (pending === undefined || pending.request !== request) return false;
    clearTimeout(pending.timer);
    this.pending.delete(call);
    pending.resolve(result);
    return true;
  }
  finish(request: number): void {
    for (const [call, pending] of this.pending) {
      if (pending.request !== request) continue;
      clearTimeout(pending.timer);
      this.pending.delete(call);
      pending.reject(new TaskError("The execution request ended before the host operation completed"));
    }
  }
}

export function createAppTools(tasks: TaskStore, executions: Executions): {
  host: Extension; main: Extension; worker: Extension;
} {
  const host = defineExtension({ name: "host-tools", tools: [
    defineTool({ name: "exec", description: "Run a program and literal arguments. Main defaults to the coordinator; name a connected host for other machines. Workers use their owning host.",
      parameters: Type.Object({ program: Type.String({ minLength: 1 }), args: Type.Array(Type.String()),
        cwd: Type.Optional(Type.String()), host: Type.Optional(Type.String()), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })) }),
      async execute(args, api) {
        const execution = executions.get(api.conversationId.toString());
        if (args.host !== undefined && execution.role === "worker") throw new TaskError("Task commands run on their owning host.");
        const chosen = args.host === undefined ? undefined : execution.hosts.find((host) => host.host_id === args.host || host.name === args.host);
        if (args.host !== undefined && chosen === undefined) throw new TaskError("Choose a connected worker host.");
        const command: HostCommand = { type: "exec", program: args.program, args: args.args,
          cwd: args.cwd ?? chosen?.cwd ?? execution.default_host?.cwd ?? execution.cwd, timeout_seconds: args.timeout_seconds ?? 900 };
        return hostOutput(await execution.call(chosen?.host_id === null || chosen?.host_id === undefined ? command
          : { type: "on_node", host_id: chosen.host_id, command }));
      } }),
    defineTool({ name: "read_context", replay: "safe", description: "Read a bounded file from a named shared context repository on the coordinator.",
      parameters: Type.Object({ repository_id: Type.String(), path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffff_ffff })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 262_144 })) }),
      async execute(args, api) {
        const execution = executions.get(api.conversationId.toString()); await tasks.context(args.repository_id);
        return hostOutput(await execution.call({ type: "read_context", repository_id: args.repository_id, path: args.path,
          offset: args.offset ?? 0, limit: args.limit ?? 64_000 }));
      } }),
    defineTool({ name: "search_context", replay: "safe", description: "Search a named shared context repository on the coordinator; returns bounded file paths and matching lines.",
      parameters: Type.Object({ repository_id: Type.String(), query: Type.String({ minLength: 1 }),
        path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      async execute(args, api) {
        const execution = executions.get(api.conversationId.toString()); await tasks.context(args.repository_id);
        return hostOutput(await execution.call({ type: "search_context", repository_id: args.repository_id, path: args.path ?? null,
          query: args.query, limit: args.limit ?? 20 }));
      } }),
    defineTool({ name: "read_file", description: "Read a bounded part of a file on the attached host; offset and limit are bytes.",
      replay: "safe", parameters: Type.Object({ path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffff_ffff })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 262_144 })) }),
      async execute(args, api) {
        return hostOutput(await executions.get(api.conversationId.toString()).call({
          type: "read_file", path: args.path, offset: args.offset ?? 0, limit: args.limit ?? 64_000,
        }));
      } }),
    defineTool({ name: "write_file", description: "Write a UTF-8 file on the attached host.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(args, api) {
        return hostOutput(await executions.get(api.conversationId.toString()).call({ type: "write_file", ...args }));
      } }),
    defineTool({ name: "edit_file", description: "Replace one exact occurrence in a UTF-8 file on the attached host.",
      parameters: Type.Object({ path: Type.String(), old: Type.String({ minLength: 1 }), new: Type.String() }),
      async execute(args, api) {
        return hostOutput(await executions.get(api.conversationId.toString()).call({ type: "edit_file", ...args }));
      } }),
  ] });
  const record = defineTool({ name: "record_task", description: "Save verified progress and the next actor/check or concrete resolution evidence.",
    parameters: Type.Object({ task_id: Type.Optional(Type.String()), summary: Type.String(), state: taskState,
      sources: Type.Optional(Type.Array(source)) }),
    async execute(args, api) {
      const execution = executions.get(api.conversationId.toString());
      const task = args.task_id === undefined
        ? (await tasks.list()).find((task) => task.conversation_id === api.conversationId.toString())
        : await tasks.get(args.task_id);
      if (task === undefined) throw new TaskError("No task owns this conversation");
      if (task.conversation_id !== api.conversationId.toString() && api.conversationId !== ROOT_CONVERSATION_ID && execution.role !== "triage") {
        throw new TaskError("A worker can update only its own task");
      }
      if (args.state.state === "waiting" && args.state.next_check !== null && !Number.isFinite(Date.parse(args.state.next_check))) {
        throw new TaskError("The next check must be an ISO timestamp or null");
      }
      return output(await tasks.record(task.id, args, { conversation_id: api.conversationId.toString(),
        call_id: api.callId, settled: api.conversationId === ROOT_CONVERSATION_ID || execution.role === "triage" }));
    } });
  const main = defineExtension({ name: "task-main", tools: [
    defineTool({ name: "search_tasks", description: "Find related existing work before creating a task. Source references are account-specific.",
      replay: "safe", parameters: Type.Object({ query: Type.String(), sources: Type.Optional(Type.Array(source)) }),
      async execute(args) { return output(await tasks.search(args.query, args.sources ?? [])); } }),
    defineTool({ name: "read_task", description: "Read a task's current state and original conversation before continuing it.",
      replay: "safe", parameters: Type.Object({ task_id: Type.String(), agent_id: Type.Optional(Type.String()) }),
      async execute(args) { return output({ task: await tasks.get(args.task_id), history: await tasks.history(args.task_id, 120_000, args.agent_id) }); } }),
    defineTool({ name: "revoke_allocation", description: "Revoke one exact unresolved worker allocation after inspecting it. Preserves pending input and history; does not retry work or delete Rex sessions.",
      parameters: Type.Object({ task_id: Type.String(), allocation_id: Type.String(), agent_id: Type.Optional(Type.String()) }),
      async execute(args) { return output(await tasks.revokeAllocation(args.task_id, args.allocation_id, args.agent_id)); } }),
    defineTool({ name: "delegate_task", description: "Continue existing work in its Rex worker, or create a separate task when no existing task fits. Queues the instruction durably.",
      parameters: Type.Object({ task_id: Type.Optional(Type.String()), input: Type.String({ minLength: 1, maxLength: 65536 }),
        title: Type.Optional(Type.String()), outcome: Type.Optional(Type.String()), host: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String({ minLength: 1 })), new_task: Type.Optional(Type.Boolean()), sources: Type.Optional(Type.Array(source)) }),
      async execute(args, api, context) {
        const execution = executions.get(api.conversationId.toString());
        let task;
        if (args.task_id === undefined) {
          const related = await tasks.search(args.input + " " + (args.title ?? ""), args.sources ?? []);
          if (related.length > 0 && args.new_task !== true) {
            return output({ related_tasks: related, instruction: "Read and continue a matching task, or set new_task for a separate outcome." });
          }
          if (args.title === undefined || args.outcome === undefined) throw new TaskError("A new task needs a concise title and outcome");
          const configured = args.host === undefined ? execution.default_host === undefined ? execution.hosts[0] : execution.default_host
            : execution.hosts.find((host) => host.name === args.host || host.host_id === args.host);
          if (configured === undefined || configured === null) throw new TaskError("Choose a connected worker host");
          const model = configured.launch?.model ?? execution.model ?? DEFAULT_MODEL;
          await tasks.inference.preflight(model);
          const id = await api.memo("task_id", randomUUID(), context);
          task = await tasks.create({ id, title: args.title, outcome: args.outcome, sources: args.sources ?? [], model });
        } else task = await tasks.get(args.task_id);
        if (task.model === null) { await tasks.selection(task.id, execution.model ?? DEFAULT_MODEL); task = await tasks.get(task.id); }
        if (task.worker.state === "bound" && args.cwd !== undefined && args.cwd !== task.worker.host.cwd) {
          throw new TaskError("Continue this task in its existing working directory");
        }
        const configured = args.host === undefined && task.worker.state === "bound" ? await tasks.workerHost(task.id)
          : args.host === undefined ? execution.default_host === undefined ? execution.hosts[0] : execution.default_host
          : execution.hosts.find((host) => host.name === args.host || host.host_id === args.host);
        if (configured === undefined || configured === null) throw new TaskError("Choose a connected worker host");
        if (task.worker.state === "bound" && (configured.host_id === null || configured.host_id === undefined
          ? task.worker.host.name !== configured.name : task.worker.binding.host_id !== configured.host_id)) {
          throw new TaskError("Continue this task on its owning host");
        }
        const host = task.worker.state === "bound" ? await tasks.workerHost(task.id)
          : args.cwd === undefined ? configured : { ...configured, cwd: args.cwd };
        const inputId = await api.memo("input_id", randomUUID(), context);
        await tasks.enqueue(task.id, args.input, inputId);
        return output(await tasks.dispatch(task.id, host, execution.call));
      } }),
    record,
  ] });
  const worker = defineExtension({ name: "task-worker", tools: [record,
    defineTool({ name: "continue_agent", description: "Give an attached agent a follow-up in its existing conversation and terminal. A finished assignment reopens; its previous result stays in history.",
      parameters: Type.Object({ agent_id: Type.String({ minLength: 1 }), input: Type.String({ minLength: 1, maxLength: 16000 }) }),
      async execute(args, api, context) {
        executions.get(api.conversationId.toString());
        const owner = await tasks.owner(api.conversationId.toString());
        if (owner.agent !== undefined) throw new TaskError("Only the parent worker may continue task agents");
        const inputId = await api.memo("agent_input_id", randomUUID(), context);
        return output(await tasks.continueAgent(owner.task.id, args.agent_id, args.input, inputId));
      } }),
    defineTool({ name: "spawn_agent", description: "Give a bounded assignment to a named terminal in this task's Rex session. The parent retains the overall outcome.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 80 }),
        outcome: Type.String({ minLength: 1, maxLength: 4000 }), input: Type.String({ minLength: 1, maxLength: 16000 }) }),
      async execute(args, api, context) {
        const execution = executions.get(api.conversationId.toString());
        const owner = await tasks.owner(api.conversationId.toString());
        if (owner.agent !== undefined) throw new TaskError("Only the parent worker may spawn task agents");
        const id = await api.memo("agent_id", randomUUID(), context);
        const inputId = await api.memo("agent_input_id", randomUUID(), context);
        await tasks.createAgent(owner.task.id, { id, inputId, ...args });
        return output(await tasks.dispatchAgent(owner.task.id, id, execution.call));
      } }),
    defineTool({ name: "read_agents", description: "Read this task's agent progress and results.", replay: "safe",
      parameters: Type.Object({}), async execute(_args, api) {
        executions.get(api.conversationId.toString());
        return output((await tasks.owner(api.conversationId.toString())).task.agents);
      } }),
    defineTool({ name: "wait_agents", description: "Wait briefly for this task's agents, then read their progress and results.", replay: "safe",
      parameters: Type.Object({ timeout_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })) }),
      async execute(args, api) {
        executions.get(api.conversationId.toString());
        const owner = await tasks.owner(api.conversationId.toString());
        if (owner.agent !== undefined) throw new TaskError("The parent worker waits for task agents");
        return output(await tasks.waitAgents(owner.task.id, (args.timeout_seconds ?? 30) * 1000));
      } }),
    defineTool({ name: "report_result", description: "Finish this agent's bounded assignment with evidence or a concrete failure. The parent still owns task resolution.",
      parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 4000 }), failure: Type.Optional(Type.String({ minLength: 1 })) }),
      async execute(args, api) {
        executions.get(api.conversationId.toString());
        const owner = await tasks.owner(api.conversationId.toString());
        if (owner.agent === undefined) throw new TaskError("Only a task agent can report an agent result");
        return output(await tasks.reportAgent(owner.task.id, owner.agent.id, args.summary, args.failure,
          { conversation_id: api.conversationId.toString(), call_id: api.callId }));
      } }),
  ] });
  return { host, main, worker };
}
