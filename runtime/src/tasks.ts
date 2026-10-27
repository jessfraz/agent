import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, defineDoc, type Conversation, type ConversationId, type Cursor, type EntryRecord, type Extension, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { HostCommand } from "./generated/HostCommand.js";
import type { HostResult } from "./generated/HostResult.js";
import type { RuntimeCommand } from "./generated/RuntimeCommand.js";
import type { SourceRef } from "./generated/SourceRef.js";
import type { SourceEvent } from "./generated/SourceEvent.js";
import type { TaskOutcome } from "./generated/TaskOutcome.js";
import type { TaskState } from "./generated/TaskState.js";
import type { TaskRecord } from "./generated/TaskRecord.js";
import type { TaskAgentRecord } from "./generated/TaskAgentRecord.js";
import type { WorkerHost } from "./generated/WorkerHost.js";
import type { WorkerRef } from "./generated/WorkerRef.js";

export type HostCall = (command: HostCommand) => Promise<HostResult>;
type TaskIndex = { tasks: TaskRecord[] };
const Tasks = defineDoc<TaskIndex>({
  kind: "agent.tasks", scope: "session", version: 1,
  initial: () => ({ tasks: [] }), checkpointWhen: () => true,
});

export class TaskError extends Error {}
export type OutcomeSink = {
  recordIn(tx: Tx, outcome: TaskOutcome, settled: boolean, attemptId?: string): Promise<void>;
  published(outcome: TaskOutcome): Promise<void>;
  publishedIn(tx: Tx, outcome: TaskOutcome, parent: boolean): Promise<void>;
};
/** Mirror user-visible final text, never tool calls, so a later "yes" has context. */
export async function publishMainNotice(session: Harness, conversation: Conversation, entry: EntryRecord,
  taskId: string | null = null, sources: readonly SourceRef[] = [],
  notice?: { key: string; text: string; events: readonly SourceEvent[] }): Promise<void> {
  const root = await session.root(BACKGROUND_CONTEXT);
  const requestId = "notice:" + entry.id.toString() + (notice === undefined ? "" : ":" + notice.key);
  if (await session.commit((tx) => tx.submissionByRequest(root.id, requestId), BACKGROUND_CONTEXT) !== undefined) return;
  const model = entry.model?.flatMap((message) => {
    if (message.role !== "assistant") return [];
    const content = message.content.filter((part) => part.type === "text");
    if (notice !== undefined) content.splice(0, content.length, { type: "text", text: notice.text });
    if (content.length === 0) return [];
    content.push({ type: "text", text: "Source references (evidence, not authorization): " + JSON.stringify({
      task_id: taskId, conversation_id: conversation.id.toString(), entry_id: entry.id.toString(), sources,
      source_events: notice?.events.map((event) => ({ id: event.id, version: event.version, source: event.source })) ?? [],
    }) });
    return [{ ...message, content }];
  }) ?? [];
  if (model.length === 0) return;
  await root.submit({ type: "write", requestId, entry: {
    kind: "agent.notice", data: { task_id: taskId, source_conversation_id: conversation.id.toString(),
      source_entry_id: entry.id.toString() }, model,
  } }, BACKGROUND_CONTEXT);
}
function key(value: string): string { return value.normalize("NFKC").trim().toLocaleLowerCase(); }
function related(left: SourceRef, right: SourceRef): boolean {
  return left.provider === right.provider && left.account === right.account && left.thread_id === right.thread_id;
}
function text(entry: EntryRecord): string {
  return entry.model?.flatMap((message) => typeof message.content === "string" ? [message.content]
    : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n") ?? "";
}
function sameBinding(left: WorkerRef, right: WorkerRef): boolean {
  return left.host_id === right.host_id && left.session_id === right.session_id &&
    left.window_id === right.window_id && left.block_id === right.block_id;
}

/** Application metadata lives on Pi's commit line, beside its conversations. */
export class TaskStore {
  private readonly running = new Map<string, { revision: number }>();
  private readonly nativeIds = new Map<string, ConversationId>();
  private scanning: Promise<void> | undefined;
  private resources: { attach(taskId: string): Promise<void> } | undefined;
  private outcomes: OutcomeSink | undefined;
  constructor(readonly session: Harness) {}
  trackOutcomes(outcomes: OutcomeSink): void { this.outcomes = outcomes; }
  private outcome(task: TaskRecord, conversationId: string, entryId: string | null, callId: string | null,
    failure?: string): TaskOutcome {
    return { task_id: task.id, conversation_id: conversationId, entry_id: entryId, tool_call_id: callId,
      summary: task.summary, sources: task.sources.map((source) => ({ ...source })),
      state: failure === undefined ? task.state.state === "open" ? { state: "progress" } : { ...task.state }
        : { state: "failed", reason: failure } };
  }
  async origin(conversation: Conversation, callId: string): Promise<EntryRecord> {
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "descending" }, 100, cursor, BACKGROUND_CONTEXT);
      const entry = page.items.find((entry) => entry.model?.some((message) => message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && part.id === callId)));
      if (entry !== undefined) return entry;
      cursor = page.next;
    } while (cursor !== undefined);
    throw new TaskError("Task outcome model provenance is unavailable");
  }
  async record(id: string, input: { summary: string; state: TaskState; sources?: SourceRef[] },
    provenance: { conversation_id: string; call_id: string; settled: boolean }): Promise<TaskRecord> {
    const origin = await this.origin(await this.conversation(provenance.conversation_id), provenance.call_id);
    await this.session.commit(async (tx) => {
      const index = await tx.doc(Tasks);
      const task = index.tasks.find((task) => task.id === id);
      if (task === undefined) throw new TaskError("Unknown task");
      task.agents ??= [];
      if (input.state.state === "resolved" && !this.canResolve(task)) throw new TaskError("Wait for unfinished task agents before resolving the task");
      task.summary = input.summary.slice(-4000); task.state = input.state; task.updated_at = Date.now();
      for (const source of input.sources ?? []) if (!task.sources.some((saved) => related(saved, source))) task.sources.push(source);
      await this.outcomes?.recordIn(tx, this.outcome(task, provenance.conversation_id, origin.id.toString(), provenance.call_id), provenance.settled);
    }, BACKGROUND_CONTEXT);
    return this.get(id);
  }
  guardResources(resources: { attach(taskId: string): Promise<void> }): void { this.resources = resources; }
  isRunning(id: string): boolean { return [...this.running.keys()].some((actor) => actor === id || actor.startsWith(id + ":")); }
  private actorKey(id: string, agentId?: string): string { return agentId === undefined ? id : id + ":" + agentId; }
  private actor(task: TaskRecord, agentId?: string): TaskRecord | TaskAgentRecord {
    if (agentId === undefined) return task;
    const agent = task.agents.find((item) => item.id === agentId);
    if (agent === undefined) throw new TaskError("Unknown task agent");
    return agent;
  }
  async owner(conversationId: string): Promise<{ task: TaskRecord; agent?: TaskAgentRecord }> {
    for (const task of await this.list()) {
      if (task.conversation_id === conversationId) return { task };
      const agent = task.agents.find((item) => item.conversation_id === conversationId);
      if (agent !== undefined) return { task, agent };
    }
    throw new TaskError("No task owns this conversation");
  }

  async list(): Promise<TaskRecord[]> {
    const state = await this.session.snapshot(Tasks, BACKGROUND_CONTEXT);
    return (state?.tasks ?? []).map((task) => ({ ...task, agents: task.agents ?? [] }))
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  }
  async get(id: string): Promise<TaskRecord> {
    const task = (await this.list()).find((task) => task.id === id);
    if (task === undefined) throw new TaskError("Unknown task");
    return task;
  }
  async canReleaseIn(tx: Tx, id: string): Promise<boolean> {
    const index = await tx.doc(Tasks);
    const task = index.tasks.find((item) => item.id === id);
    if (task === undefined) return false;
    task.agents ??= [];
    return task.state.state === "resolved" && task.pending.length === 0 && !this.isRunning(id) &&
      task.worker.state !== "allocating" && task.worker.state !== "uncertain" && this.canResolve(task);
  }
  async conversation(id: string): Promise<Conversation> {
    if (!this.nativeIds.has(id)) {
      this.scanning ??= (async () => {
        let cursor: Cursor | undefined;
        do {
          const page = await this.session.commit((tx) => tx.scanConversations({}, 100, cursor), BACKGROUND_CONTEXT);
          for (const native of page.items) this.nativeIds.set(native.id.toString(), native.id);
          cursor = page.next;
        } while (cursor !== undefined);
      })().finally(() => { this.scanning = undefined; });
      await this.scanning;
    }
    const native = this.nativeIds.get(id);
    if (native !== undefined) {
      const conversation = await this.session.conversation(native, BACKGROUND_CONTEXT);
      if (conversation !== undefined) return conversation;
      this.nativeIds.delete(id);
    }
    throw new TaskError("Task conversation is unavailable");
  }
  async history(id: string, maxCharacters = 120_000, agentId?: string): Promise<string> {
    const conversation = await this.conversation(this.actor(await this.get(id), agentId).conversation_id);
    let cursor: Cursor | undefined;
    const chunks: string[] = [];
    let length = 0;
    do {
      const page = await conversation.entries({ order: "descending" }, 100, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        const content = text(entry);
        if (content.length === 0) continue;
        chunks.push(content);
        length += content.length;
        if (length >= maxCharacters) return chunks.reverse().join("\n").slice(-maxCharacters);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return chunks.reverse().join("\n");
  }
  private async historyScore(conversationId: string, tokens: readonly string[]): Promise<number> {
    const conversation = await this.conversation(conversationId);
    const matched = new Set<string>();
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "descending" }, 100, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        const content = key(text(entry));
        for (const token of tokens) if (content.includes(token)) matched.add(token);
      }
      if (matched.size === tokens.length) break;
      cursor = page.next;
    } while (cursor !== undefined);
    return matched.size;
  }
  async search(query: string, sources: readonly SourceRef[] = [], limit = 8): Promise<TaskRecord[]> {
    const stop = ["the", "and", "for", "you", "our", "this", "that", "with", "please", "can", "have", "from"];
    const tokens = (key(query).match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1 && !stop.includes(token));
    const scored: { task: TaskRecord; score: number }[] = [];
    for (const task of await this.list()) {
      const sourceMatch = sources.some((source) =>
        (source.provider === "task_outcomes" && source.account === "local" && source.thread_id === task.id) ||
        task.sources.some((saved) => related(saved, source)));
      const title = key([task.title, task.outcome, ...task.agents.flatMap((agent) => [agent.title, agent.outcome])].join(" "));
      const summary = key([task.summary, ...task.agents.map((agent) => agent.summary)].join(" "));
      let score = sourceMatch ? 1000 : 0;
      for (const token of tokens) score += title.includes(token) ? 4 : summary.includes(token) ? 2 : 0;
      if (!sourceMatch && tokens.length > 0) {
        score += await this.historyScore(task.conversation_id, tokens);
        for (const agent of task.agents) score += await this.historyScore(agent.conversation_id, tokens);
      }
      if (sourceMatch || (tokens.length === 0 && sources.length === 0) || (tokens.length > 0 && score > 0)) scored.push({ task, score });
    }
    return scored.sort((a, b) => b.score - a.score || b.task.updated_at - a.task.updated_at)
      .slice(0, Math.min(20, Math.max(1, limit))).map((item) => item.task);
  }
  async create(input: { id?: string; title: string; outcome: string; sources?: SourceRef[] }): Promise<TaskRecord> {
    const id = input.id ?? randomUUID();
    if (input.title.trim().length === 0 || input.outcome.trim().length === 0) throw new TaskError("Task title and outcome are required");
    const native = await this.session.commit(async (tx) => {
      const index = await tx.doc(Tasks);
      if (index.tasks.some((task) => task.id === id)) return;
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      index.tasks.push({
        id, conversation_id: conversation.id.toString(), title: input.title.trim(), outcome: input.outcome.trim(),
        summary: "", state: { state: "open" }, worker: { state: "unassigned" },
        sources: input.sources ?? [], pending: [], agents: [], updated_at: Date.now(),
      });
      return conversation.id;
    }, BACKGROUND_CONTEXT);
    if (native !== undefined) this.nativeIds.set(native.toString(), native);
    return this.get(id);
  }
  async updateIn(tx: Tx, id: string, change: (task: TaskRecord) => void): Promise<void> {
    const index = await tx.doc(Tasks);
    const task = index.tasks.find((task) => task.id === id);
    if (task === undefined) throw new TaskError("Unknown task");
    task.agents ??= [];
    change(task);
    task.updated_at = Date.now();
  }
  async update(id: string, change: (task: TaskRecord) => void): Promise<TaskRecord> {
    await this.session.commit((tx) => this.updateIn(tx, id, change), BACKGROUND_CONTEXT);
    return this.get(id);
  }
  async enqueue(id: string, content: string, inputId: string = randomUUID(), delivered?: TaskOutcome): Promise<TaskRecord> {
    if (content.trim().length === 0 || Buffer.byteLength(content, "utf8") > 65_536) throw new TaskError("Task input must contain 1 to 65536 UTF-8 bytes");
    await this.resources?.attach(id);
    await this.session.commit(async (tx) => {
      await this.updateIn(tx, id, (task) => {
        const previous = task.pending.find((input) => input.id === inputId);
        if (previous !== undefined && previous.content !== content) throw new TaskError("A task input ID cannot be reused with different content");
        if (previous === undefined) task.pending.push({ id: inputId, content });
        task.state = { state: "open" };
      });
      if (delivered !== undefined) await this.outcomes?.publishedIn(tx, delivered, true);
    }, BACKGROUND_CONTEXT);
    const task = await this.get(id);
    const running = this.running.get(id);
    if (running !== undefined) running.revision += 1;
    return task;
  }
  async createAgent(taskId: string, input: { id: string; title: string; outcome: string; input: string; inputId: string }): Promise<TaskAgentRecord> {
    if (input.title.trim().length === 0 || input.title.length > 80 || input.outcome.trim().length === 0 ||
        input.outcome.length > 4000 || input.input.trim().length === 0 || Buffer.byteLength(input.input, "utf8") > 65_536) {
      throw new TaskError("An agent needs a title, bounded outcome, and instruction");
    }
    await this.resources?.attach(taskId);
    const native = await this.session.commit(async (tx) => {
      const index = await tx.doc(Tasks);
      const task = index.tasks.find((item) => item.id === taskId);
      if (task === undefined) throw new TaskError("Unknown task");
      task.agents ??= [];
      if (task.agents.some((agent) => agent.id === input.id)) return;
      if (task.agents.filter((agent) => agent.state.state === "open").length >= 8) throw new TaskError("This task already has eight unfinished agents");
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      task.agents.push({ id: input.id, conversation_id: conversation.id.toString(), title: input.title.trim(),
        outcome: input.outcome.trim(), summary: "", state: { state: "open" }, worker: { state: "unassigned" },
        pending: [{ id: input.inputId, content: input.input }], updated_at: Date.now() });
      task.state = { state: "open" };
      task.updated_at = Date.now();
      return conversation.id;
    }, BACKGROUND_CONTEXT);
    if (native !== undefined) this.nativeIds.set(native.toString(), native);
    const agent = (await this.get(taskId)).agents.find((item) => item.id === input.id);
    if (agent === undefined) throw new TaskError("Agent creation did not commit");
    return agent;
  }
  async dispatchAgent(taskId: string, agentId: string, call: HostCall): Promise<TaskRecord> {
    const task = await this.get(taskId);
    const existing = this.actor(task, agentId);
    if (existing.worker.state === "bound") return task;
    const parent = task.worker;
    if (parent.state !== "bound") throw new TaskError("A bound task worker must own the agent's Rex session");
    const allocation_id = randomUUID();
    let title = "";
    await this.update(taskId, (saved) => {
      const agent = this.actor(saved, agentId);
      if (agent.worker.state !== "unassigned") throw new TaskError("Agent allocation already exists; inspect it before retrying");
      agent.worker = { state: "allocating", allocation_id, host: parent.host }; title = agent.title;
    });
    let result: HostResult;
    try { result = await call({ type: "spawn_subagent", host: parent.host, parent: parent.binding,
      task_id: taskId, agent_id: agentId, allocation_id, title }); }
    catch { result = { type: "creation_uncertain", session_id: parent.binding.session_id }; }
    return this.update(taskId, (saved) => {
      const agent = this.actor(saved, agentId);
      if (result.type === "spawned" && result.binding.host_id === parent.binding.host_id &&
          result.binding.session_id === parent.binding.session_id) {
        agent.worker = { state: "bound", allocation_id, host: parent.host, binding: result.binding };
      } else agent.worker = { state: "uncertain", allocation_id, host: parent.host, session_id: parent.binding.session_id };
    });
  }
  async reportAgent(taskId: string, agentId: string, summary: string, failure?: string,
    provenance?: { conversation_id: string; call_id: string }): Promise<TaskRecord> {
    const origin = provenance === undefined ? undefined
      : await this.origin(await this.conversation(provenance.conversation_id), provenance.call_id);
    await this.session.commit(async (tx) => {
      const index = await tx.doc(Tasks);
      const task = index.tasks.find((task) => task.id === taskId);
      const agent = task?.agents.find((item) => item.id === agentId);
      if (task === undefined || agent === undefined) throw new TaskError("Unknown task agent");
      agent.summary = summary.slice(-4000);
      agent.state = failure === undefined ? { state: "done" } : { state: "failed", reason: failure };
      agent.updated_at = Date.now(); task.updated_at = Date.now();
      const outcome: TaskOutcome = { ...this.outcome(task, agent.conversation_id, origin?.id.toString() ?? null,
        provenance?.call_id ?? null, failure), summary: agent.summary,
        state: failure === undefined ? { state: "progress" } : { state: "failed", reason: failure } };
      await this.outcomes?.recordIn(tx, outcome, false);
    }, BACKGROUND_CONTEXT);
    return this.get(taskId);
  }
  async waitAgents(taskId: string, timeoutMs: number): Promise<TaskAgentRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const agents = (await this.get(taskId)).agents;
      if (agents.every((agent) => agent.state.state !== "open" && !this.running.has(this.actorKey(taskId, agent.id))) || Date.now() >= deadline) return agents;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }
  canResolve(task: TaskRecord): boolean {
    return task.agents.every((agent) => agent.state.state !== "open" && agent.pending.length === 0 &&
      agent.worker.state !== "allocating" && agent.worker.state !== "uncertain" && !this.running.has(this.actorKey(task.id, agent.id)));
  }
  async dispatch(id: string, host: WorkerHost, call: HostCall): Promise<TaskRecord> {
    await this.resources?.attach(id);
    const current = await this.get(id);
    if (this.running.has(id)) return current;
    if (current.worker.state === "allocating" || current.worker.state === "uncertain") {
      throw new TaskError("Worker allocation needs reconciliation; no duplicate session was created");
    }
    if (current.worker.state === "bound") {
      if (current.worker.host.name !== host.name) throw new TaskError("Continue this task on its owning host");
      const previous = current.worker;
      const claimed = await this.session.commit(async (tx) => {
        const index = await tx.doc(Tasks);
        const task = index.tasks.find((task) => task.id === id);
        if (task === undefined || task.worker.state !== "bound" ||
            task.worker.allocation_id !== previous.allocation_id || !sameBinding(task.worker.binding, previous.binding)) return false;
        task.worker = { state: "allocating", allocation_id: previous.allocation_id, host: previous.host };
        task.updated_at = Date.now();
        return true;
      }, BACKGROUND_CONTEXT);
      if (!claimed) throw new TaskError("Another worker transition owns this task");
      let result: HostResult;
      try { result = await call({ type: "resume_worker", host: previous.host, allocation_id: previous.allocation_id,
        binding: previous.binding, task_id: id }); }
      catch { result = { type: "creation_uncertain", session_id: previous.binding.session_id }; }
      return this.update(id, (task) => {
        if (result.type === "spawned" && result.binding.session_id === previous.binding.session_id &&
            result.binding.host_id === previous.binding.host_id) {
          task.worker = { ...previous, binding: result.binding };
        } else if (result.type === "written") task.worker = previous;
        else task.worker = { state: "uncertain", allocation_id: previous.allocation_id,
          host: previous.host, session_id: previous.binding.session_id };
      });
    }
    const allocation_id = randomUUID();
    const claimed = await this.session.commit(async (tx) => {
      const index = await tx.doc(Tasks);
      const task = index.tasks.find((task) => task.id === id);
      if (task === undefined) throw new TaskError("Unknown task");
      if (task.worker.state !== "unassigned") return false;
      task.worker = { state: "allocating", allocation_id, host };
      task.updated_at = Date.now();
      return true;
    }, BACKGROUND_CONTEXT);
    if (!claimed) throw new TaskError("A worker allocation already owns this task");
    let result: HostResult;
    try { result = await call({ type: "spawn_worker", host, task_id: id, allocation_id, title: current.title }); }
    catch {
      await this.update(id, (task) => { task.worker = { state: "uncertain", allocation_id, host, session_id: null }; });
      throw new TaskError("Worker creation could not be confirmed; reconcile it before retrying");
    }
    return this.update(id, (task) => {
      if (result.type === "spawned") task.worker = { state: "bound", allocation_id, host, binding: result.binding };
      else task.worker = { state: "uncertain", allocation_id, host,
        session_id: result.type === "creation_uncertain" ? result.session_id : null };
    });
  }
  private async finishOutcome(id: string, conversationId: string, entryId: string, answer: string): Promise<TaskOutcome> {
    let outcome: TaskOutcome | undefined;
    await this.session.commit(async (tx) => {
      await this.updateIn(tx, id, (task) => {
        task.summary = answer.slice(-4000);
        outcome = this.outcome(task, conversationId, entryId, null);
      });
      if (outcome !== undefined) await this.outcomes?.recordIn(tx, outcome, false);
    }, BACKGROUND_CONTEXT);
    if (outcome === undefined) throw new TaskError("Task outcome did not commit");
    return outcome;
  }
  async run(input: Extract<RuntimeCommand, { type: "run_task" }>,
    bind: (conversation: Conversation, host: WorkerHost) => () => void,
    notice: (task: TaskRecord, text: string) => void,
    extensions: readonly Extension[] = [], call?: HostCall, prepare?: () => Promise<void>): Promise<{ conversation_id: string; text: string }> {
    const actorKey = this.actorKey(input.task_id, input.agent_id);
    if (this.running.has(actorKey)) throw new TaskError("This task already has an attached worker");
    const active = { revision: 0 };
    const attemptId = randomUUID();
    this.running.set(actorKey, active);
    let unbind: (() => void) | undefined;
    let attached = false;
    let answer = "";
    let finalOutcome: TaskOutcome | undefined;
    let answerEntry: EntryRecord | undefined;
    try {
      const deadline = Date.now() + 10_000;
      let task = await this.get(input.task_id);
      let actor = this.actor(task, input.agent_id);
      while (actor.worker.state === "allocating" && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        task = await this.get(input.task_id);
        actor = this.actor(task, input.agent_id);
      }
      if (actor.worker.state !== "bound" || actor.worker.allocation_id !== input.allocation_id ||
          !sameBinding(actor.worker.binding, input.binding)) {
        throw new TaskError("Worker binding is not confirmed for this task");
      }
      attached = true;
      await prepare?.();
      await this.resources?.attach(input.task_id);
      const conversation = await this.conversation(actor.conversation_id);
      unbind = bind(conversation, actor.worker.host);
      await conversation.configure({
        model: { provider: "openai", modelId: input.model },
        instructions: input.instructions + "\n\nTask outcome: " + actor.outcome +
          (input.agent_id === undefined
            ? "\nRecord verified progress, the next actor/check, or resolution evidence. Agents share this task's Rex session; wait for their results before resolving it."
            : "\nComplete this bounded assignment and call report_result with evidence or a concrete failure. The parent owns the overall task."),
        cwd: input.cwd, extensions,
      }, BACKGROUND_CONTEXT);
      this.session.resume();
      while (true) {
        const revision = active.revision;
        task = await this.get(input.task_id);
        actor = this.actor(task, input.agent_id);
        const next = actor.pending[0];
        if (next === undefined) {
          await conversation.waitForIdle(BACKGROUND_CONTEXT);
          if (active.revision !== revision) continue;
          task = await this.get(input.task_id);
          actor = this.actor(task, input.agent_id);
          if (actor.pending.length > 0) continue;
          if (answer.length === 0) {
            let cursor: Cursor | undefined;
            do {
              const page = await conversation.entries({ order: "descending" }, 100, cursor, BACKGROUND_CONTEXT);
              const previous = page.items.find((entry) => AssistantEntry.is(entry));
              if (previous !== undefined) {
                answer = text(previous); answerEntry = previous;
                if (input.agent_id === undefined) {
                  finalOutcome = await this.finishOutcome(task.id, conversation.id.toString(), previous.id.toString(), answer);
                  await publishMainNotice(this.session, conversation, previous, task.id, task.sources);
                  await this.outcomes?.published(finalOutcome);
                }
                break;
              }
              cursor = page.next;
            } while (cursor !== undefined);
            if (answer.length > 0 && actor.summary !== answer.slice(-4000)) {
              task = await this.update(task.id, (current) => { this.actor(current, input.agent_id).summary = answer.slice(-4000); });
              if (input.agent_id === undefined) notice(task, answer);
            }
          }
          // Recovery publishes history asynchronously; admission during that window still belongs to this actor.
          task = await this.get(input.task_id);
          if (active.revision !== revision || this.actor(task, input.agent_id).pending.length > 0) continue;
          break;
        }
        const submission = await conversation.submit({ type: "input", content: next.content, requestId: next.id }, BACKGROUND_CONTEXT);
        await this.update(task.id, (current) => {
          const currentActor = this.actor(current, input.agent_id);
          currentActor.pending = currentActor.pending.filter((item) => item.id !== next.id);
        });
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.type !== "input" || settled.status !== "done") {
          throw new TaskError("The worker turn did not complete; its conversation is retained");
        }
        const entry = await conversation.commit((tx) => tx.entry(settled.answer), BACKGROUND_CONTEXT);
        answer = entry === undefined ? "" : text(entry); answerEntry = entry;
        if (entry !== undefined && input.agent_id === undefined) {
          finalOutcome = await this.finishOutcome(task.id, conversation.id.toString(), entry.id.toString(), answer);
          await publishMainNotice(this.session, conversation, entry, task.id, task.sources);
          await this.outcomes?.published(finalOutcome);
        }
        task = await this.update(task.id, (current) => {
          const currentActor = this.actor(current, input.agent_id);
          if (input.agent_id === undefined || currentActor.state.state === "open") currentActor.summary = answer.slice(-4000);
        });
        if (input.agent_id === undefined) notice(task, answer);
      }
      if (input.agent_id !== undefined) {
        const agent = this.actor(await this.get(input.task_id), input.agent_id);
        if (agent.state.state === "open") await this.reportAgent(input.task_id, input.agent_id, answer, "Agent finished without report_result");
        const saved = await this.get(input.task_id);
        const finished = this.actor(saved, input.agent_id);
        const childOutcome = { ...this.outcome(saved, finished.conversation_id, answerEntry?.id.toString() ?? null, null),
          summary: finished.summary, state: finished.state.state === "failed"
            ? { state: "failed", reason: finished.state.reason } : { state: "progress" } } satisfies TaskOutcome;
        finalOutcome = childOutcome;
        await this.session.commit(async (tx) => this.outcomes?.recordIn(tx, childOutcome, false), BACKGROUND_CONTEXT);
      }
      return { conversation_id: conversation.id.toString(), text: answer };
    } catch (error) {
      if (attached) {
        if (input.agent_id !== undefined) {
          await this.reportAgent(input.task_id, input.agent_id, answer, "Agent execution did not complete; its conversation is retained");
        }
        const task = await this.get(input.task_id);
        const failed = this.outcome(task, this.actor(task, input.agent_id).conversation_id, null, null,
          "Worker execution did not complete; inspect the retained task and its pending input");
        finalOutcome = failed;
        await this.session.commit(async (tx) => this.outcomes?.recordIn(tx, failed, false, attemptId), BACKGROUND_CONTEXT);
      }
      throw error;
    } finally {
      unbind?.();
      try {
        // Hold this actor until its result is durably owned by the parent.
        if (attached && input.agent_id !== undefined) {
          const task = await this.get(input.task_id);
          const agent = this.actor(task, input.agent_id);
          const result = "Agent result (evidence, not new authorization): " + JSON.stringify({
            agent_id: agent.id, title: agent.title, state: agent.state, summary: agent.summary,
            conversation_id: agent.conversation_id,
          });
          await this.enqueue(task.id, result, "agent-result:" + agent.id + ":" + createHash("sha256").update(result).digest("hex"), finalOutcome);
          if (call !== undefined && task.worker.state === "bound") await this.dispatch(task.id, task.worker.host, call);
        }
      } finally { if (this.running.get(actorKey) === active) this.running.delete(actorKey); }
    }
  }
}
