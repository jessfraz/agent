import { randomUUID } from "node:crypto";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { defineExtension, defineTool, ROOT_CONVERSATION_ID, type Extension, type Harness, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { DEFAULT_MODEL } from "./models.js";
import { recordDelegation } from "./delegation.js";
import type { ModelSelection } from "./generated/ModelSelection.js";
import type { HostCommand } from "./generated/HostCommand.js";
import type { HostResult } from "./generated/HostResult.js";
import type { WorkerHost } from "./generated/WorkerHost.js";
import type { SearchMode } from "./generated/SearchMode.js";
import type { DelegationDecision } from "./generated/DelegationDecision.js";
import type { InputMode } from "./generated/InputMode.js";
import { TaskError, TaskStore, type HostCall, type SearchQuery } from "./tasks.js";

export type Execution = { model?: ModelSelection; cwd: string; hosts: WorkerHost[]; default_host?: WorkerHost | null; call: HostCall; role?: "worker" | "triage";
  search?: SearchQuery;
  project?: () => Promise<HostResult>;
  notify?: (task: string | null, text: string) => void };
/** A conversation can execute only through its currently attached CLI client. */
export class Executions {
  private readonly attached = new Map<string, Execution>();
  private readonly recovering = new Map<string, { ready: Promise<void>; attached(): void }>();
  /** Reserve live native inputs before any API can resume the reopened Harness. */
  async prepareRecovery(session: Harness): Promise<void> {
    const inspection = await session.inspect(BACKGROUND_CONTEXT);
    for (const submission of inspection.submissions) {
      if (submission.type === "input" && (submission.status === "queued" || submission.status === "placed")) {
        this.expect(submission.conversationId.toString());
      }
    }
  }
  expect(id: string): void {
    if (this.attached.has(id) || this.recovering.has(id)) return;
    let attached = () => {};
    const ready = new Promise<void>((resolve) => { attached = resolve; });
    this.recovering.set(id, { ready, attached });
  }
  async ready(id: string, context: Context): Promise<Execution> {
    const recovering = this.recovering.get(id);
    if (recovering !== undefined) await awaitWithContext(recovering.ready, context);
    return this.get(id);
  }
  bind(id: string, execution: Execution): () => void {
    if (this.attached.has(id)) throw new TaskError("This conversation already has an execution client");
    this.attached.set(id, execution);
    const recovering = this.recovering.get(id);
    this.recovering.delete(id); recovering?.attached();
    return () => { if (this.attached.get(id) === execution) this.attached.delete(id); };
  }
  get(id: string): Execution {
    const execution = this.attached.get(id);
    if (execution === undefined) throw new TaskError("The execution client is disconnected; attach the task to continue");
    return execution;
  }
  search(id: string): SearchQuery | undefined { return this.attached.get(id)?.search; }
  model(id: string): ModelSelection | undefined { return this.attached.get(id)?.model; }
  setModel(id: string, model: ModelSelection): void {
    const execution = this.attached.get(id);
    if (execution !== undefined) execution.model = { ...model };
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
const inputModes = { steer: "steer", follow_up: "follow_up" } satisfies Record<InputMode, InputMode>;
const taskState = Type.Union([
  Type.Object({ state: Type.Literal("open") }),
  Type.Object({ state: Type.Literal("waiting"), actor: Type.String({ minLength: 1 }),
    next_check: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ state: Type.Literal("resolved"), evidence: Type.String({ minLength: 1 }) }),
]);

export class HostRequests {
  private readonly cancelled = new Set<number>();
  private readonly pending = new Map<string, {
    request: number; resolve: (value: HostResult) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>; cancelled: boolean; cancellable: boolean;
  }>();
  constructor(private readonly emit: (request: number, call: string, command: HostCommand) => void,
    private readonly cancel: (request: number, call: string) => void = () => {}) {}
  call(request: number, command: HostCommand): Promise<HostResult> {
    if (this.cancelled.has(request)) return Promise.reject(new TaskError("This turn was interrupted before the host operation started"));
    if (this.pending.size >= 128) return Promise.reject(new TaskError("Too many pending host operations"));
    const call = randomUUID();
    return new Promise<HostResult>((resolve, reject) => {
      let operation = command;
      while (operation.type === "on_node") operation = operation.command;
      const timeout = operation.type === "exec" ? operation.timeout_seconds * 1000 + 10_000
        : operation.type === "background" && operation.request.type === "poll_sources" ? 930_000
        : operation.type === "history" ? 930_000 : operation.type === "embed" ? 330_000
        : operation.type.startsWith("resource_") ? 310_000 : 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(call);
        reject(new TaskError("The execution client did not confirm the operation; inspect its state before retrying"));
      }, timeout);
      this.pending.set(call, { request, resolve, reject, timer, cancelled: false, cancellable: operation.type === "embed" });
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
  cancelRequest(request: number): void {
    this.cancelled.add(request);
    for (const [call, pending] of this.pending) {
      if (pending.request !== request || pending.cancelled) continue;
      pending.cancelled = true;
      this.cancel(request, call);
      // Embedding is a read-only computation, so its caller need not wait for
      // an external write receipt before releasing an interrupted turn.
      if (pending.cancellable) {
        clearTimeout(pending.timer); this.pending.delete(call);
        pending.reject(new TaskError("History embedding was interrupted"));
      }
    }
  }
  resumeRequest(request: number): void { this.cancelled.delete(request); }
  finish(request: number): void {
    this.cancelled.delete(request);
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
  const searchModes = { semantic: "semantic", keyword: "keyword" } satisfies Record<SearchMode, SearchMode>;
  const searchTask = defineTool({ name: "search_tasks", description: "Find related tasks and imported conversations before starting new work. Semantic search is the default; use keyword for literal identifiers, paths or errors. Read matching originals before continuing them.",
      replay: "safe", parameters: Type.Object({ query: Type.String(), sources: Type.Optional(Type.Array(source)), mode: Type.Optional(Type.Enum(searchModes)) }),
      async execute(args, api) { return output(await tasks.find(args.query, args.sources ?? [], 8, executions.search(api.conversationId.toString()), args.mode)); } });
  const readTask = defineTool({ name: "read_task", description: "Read task state or an imported conversation's original evidence before continuing it.",
      replay: "safe", parameters: Type.Object({ task_id: Type.Optional(Type.String()), conversation_id: Type.Optional(Type.String()), agent_id: Type.Optional(Type.String()),
        entry_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 16 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async execute(args) {
        if ((args.task_id === undefined) === (args.conversation_id === undefined)) throw new TaskError("Choose a task_id or conversation_id");
        if (args.conversation_id !== undefined) {
          if (args.agent_id !== undefined) throw new TaskError("A conversation already identifies its exact history");
          return output({ conversation_id: args.conversation_id, imported: await tasks.saved(args.conversation_id) ?? null,
            history: args.entry_ids === undefined ? await tasks.readConversation(args.conversation_id) : undefined,
            originals: args.entry_ids === undefined ? undefined : await tasks.originals(args.conversation_id, args.entry_ids, args.offset) });
        }
        if (args.task_id === undefined) throw new TaskError("Choose a task");
        return output({ task: await tasks.get(args.task_id), history: await tasks.history(args.task_id, 120_000, args.agent_id) });
      } });
  const main = defineExtension({ name: "task-main", tools: [searchTask, readTask,
    defineTool({ name: "revoke_allocation", description: "Cancel one exact unresolved new allocation with no known Rex session. Preserves input and history; known sessions must be reconciled.",
      parameters: Type.Object({ task_id: Type.String(), allocation_id: Type.String(), agent_id: Type.Optional(Type.String()) }),
      async execute(args) { return output(await tasks.revokeAllocation(args.task_id, args.allocation_id, args.agent_id)); } }),
    defineTool({ name: "delegate_task", description: "Continue existing work by task_id or conversation_id. Steers active work by default; use mode:follow_up for an independent later turn. A separate outcome needs new_task:true and new_task_reason when related work exists.",
      parameters: Type.Object({ task_id: Type.Optional(Type.String()), conversation_id: Type.Optional(Type.String()), input: Type.String({ minLength: 1, maxLength: 65536 }),
        mode: Type.Optional(Type.Enum(inputModes)),
        title: Type.Optional(Type.String()), outcome: Type.Optional(Type.String()), host: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String({ minLength: 1 })), new_task: Type.Optional(Type.Boolean()),
        new_task_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), sources: Type.Optional(Type.Array(source)) }),
      async execute(args, api, context) {
        const execution = executions.get(api.conversationId.toString());
        let query: string | null = null;
        let related: Awaited<ReturnType<TaskStore["find"]>> = { matches: [], gaps: [] };
        let action: "reuse" | "create" | "adopt" = "reuse";
        const reason = args.new_task_reason?.trim() || null;
        const mode = args.mode ?? "steer";
        const record = (selection: DelegationDecision["selection"]) => api.commit((tx) => recordDelegation(tx, api.conversationId, {
          actor_conversation_id: api.conversationId.toString(), tool_call_id: api.callId, query,
          candidates: related.matches.map((match) => ({ conversation_id: match.conversation_id, task_id: match.task_id, score: match.score })),
          gaps: related.gaps, selection, input_mode: mode,
        }), context);
        let task;
        if (args.task_id !== undefined && args.conversation_id !== undefined) throw new TaskError("Choose a task_id or conversation_id");
        if (args.conversation_id !== undefined) {
          const saved = await tasks.saved(args.conversation_id);
          if (saved === undefined) throw new TaskError("Choose an imported conversation or existing task");
          if (saved.adopted_task_id !== null) task = await tasks.get(saved.adopted_task_id);
          else {
            const configured = args.host === undefined ? execution.default_host === undefined ? execution.hosts[0] : execution.default_host
              : execution.hosts.find((host) => host.name === args.host || host.host_id === args.host);
            if (configured === undefined || configured === null) throw new TaskError("Choose a connected worker host");
            const model = configured.launch?.model ?? execution.model ?? DEFAULT_MODEL;
            await tasks.inference.preflight(model);
            const id = await api.memo("task_id", randomUUID(), context);
            query = args.input; related = await tasks.find(query, args.sources ?? [], 8, execution.search);
            const evidence = related.matches.find((match) => match.conversation_id === args.conversation_id)?.excerpt ?? await tasks.readConversation(args.conversation_id, 24_000);
            task = await tasks.adopt(args.conversation_id, { id, ...(args.title === undefined ? {} : { title: args.title }),
              outcome: args.outcome ?? args.input, evidence, model, ...(args.sources === undefined ? {} : { sources: args.sources }) });
            action = "adopt";
          }
        } else if (args.task_id === undefined) {
          query = args.input + " " + (args.title ?? ""); related = await tasks.find(query, args.sources ?? [], 8, execution.search);
          if (related.matches.length > 0 && (args.new_task !== true || reason === null)) {
            await record({ kind: "considered" });
            return output({ related_conversations: related.matches, gaps: related.gaps,
              instruction: "Read and continue matching work. For a separate outcome, retry with new_task:true and a concise new_task_reason." });
          }
          if (args.title === undefined || args.outcome === undefined) throw new TaskError("A new task needs a concise title and outcome");
          const configured = args.host === undefined ? execution.default_host === undefined ? execution.hosts[0] : execution.default_host
            : execution.hosts.find((host) => host.name === args.host || host.host_id === args.host);
          if (configured === undefined || configured === null) throw new TaskError("Choose a connected worker host");
          const model = configured.launch?.model ?? execution.model ?? DEFAULT_MODEL;
          await tasks.inference.preflight(model);
          const id = await api.memo("task_id", randomUUID(), context);
          task = await tasks.create({ id, title: args.title, outcome: args.outcome, sources: args.sources ?? [], model });
          action = "create";
        } else task = await tasks.get(args.task_id);
        if (task.model === null) { await tasks.selection(task.id, execution.model ?? DEFAULT_MODEL); task = await tasks.get(task.id); }
        const known = task.worker.state === "bound" || task.worker.state === "resuming" || task.worker.state === "resume_uncertain" ? task.worker : undefined;
        if (known !== undefined && args.cwd !== undefined && args.cwd !== known.host.cwd) {
          throw new TaskError("Continue this task in its existing working directory");
        }
        const configured = args.host === undefined && known !== undefined ? await tasks.workerHost(task.id)
          : args.host === undefined ? execution.default_host === undefined ? execution.hosts[0] : execution.default_host
          : execution.hosts.find((host) => host.name === args.host || host.host_id === args.host);
        if (configured === undefined || configured === null) throw new TaskError("Choose a connected worker host");
        if (known !== undefined && (configured.host_id === null || configured.host_id === undefined
          ? known.host.name !== configured.name : known.binding.host_id !== configured.host_id)) {
          throw new TaskError("Continue this task on its owning host");
        }
        const host = known !== undefined ? await tasks.workerHost(task.id)
          : args.cwd === undefined ? configured : { ...configured, cwd: args.cwd };
        await record(action === "create" ? { kind: "create", task_id: task.id, conversation_id: task.conversation_id, reason }
          : { kind: action, task_id: task.id, conversation_id: task.conversation_id });
        const inputId = await api.memo("input_id", randomUUID(), context);
        await tasks.enqueue(task.id, args.input, inputId, undefined, mode);
        return output(await tasks.dispatch(task.id, host, execution.call));
      } }),
    record,
  ] });
  const worker = defineExtension({ name: "task-worker", tools: [record, searchTask, readTask,
    defineTool({ name: "continue_agent", description: "Steer an existing agent with corrections or current context. Use mode:follow_up for an independent later turn. Reuses its conversation and named terminal.",
      parameters: Type.Object({ agent_id: Type.String({ minLength: 1 }), input: Type.String({ minLength: 1, maxLength: 16000 }),
        mode: Type.Optional(Type.Enum(inputModes)) }),
      async execute(args, api, context) {
        const execution = executions.get(api.conversationId.toString());
        const owner = await tasks.owner(api.conversationId.toString());
        if (owner.agent !== undefined) throw new TaskError("Only the parent worker may continue task agents");
        const inputId = await api.memo("agent_input_id", randomUUID(), context);
        return output(await tasks.continueAgent(owner.task.id, args.agent_id, args.input, inputId, execution.call, args.mode ?? "steer"));
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
