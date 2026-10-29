import { randomUUID } from "node:crypto";
import { validateInput } from "./attachments.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, type Conversation, type Harness } from "@earendil-works/pi-durable";
import type { ConversationCatalog } from "./catalog.js";
import type { CoordinatorEnvironment } from "./environment.js";
import type { HistoryStore } from "./history.js";
import { reconcileMainInput } from "./main_observation.js";
import type { ConversationModels } from "./models.js";
import { TaskError, type HostCall, type TaskStore } from "./tasks.js";
import { activity } from "./transcript.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { RuntimeCommand } from "./generated/RuntimeCommand.js";
import type { SavedConversation } from "./generated/SavedConversation.js";
import type { TaskRecord } from "./generated/TaskRecord.js";
import type { WorkerHost } from "./generated/WorkerHost.js";

export interface ConversationServices {
  harness: Harness;
  tasks: TaskStore;
  histories: HistoryStore;
  inference: ConversationModels;
  environment: CoordinatorEnvironment;
  catalog: ConversationCatalog;
}
type Emit = (event: RuntimeEventKind) => void;
type View = { conversation_id: string; closed: boolean; finish(): void };

/** A view observes Pi; independently admitted inputs retain normal Rex ownership. */
export class ConversationViews {
  private readonly views = new Map<number, View>();
  constructor(private readonly services: () => Promise<ConversationServices>,
    private readonly attached: (request: number, conversation: Conversation) => void) {}

  detach(id: number): void {
    const view = this.views.get(id);
    if (view !== undefined) { view.closed = true; view.finish(); }
  }
  close(): void { for (const id of this.views.keys()) this.detach(id); }
  private async summary(app: ConversationServices, id: string): Promise<SavedConversation> {
    const page = await app.catalog.list(id, null, 100);
    const item = page.items.find((item) => item.conversation_id === id);
    if (item === undefined) throw new TaskError("Choose an existing saved conversation");
    return item;
  }
  async attach(id: number, conversation_id: string, emit: Emit, inputIds: readonly string[] = []): Promise<void> {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const view: View = { conversation_id, closed: false, finish }; this.views.set(id, view);
    let stop: (() => Promise<void>) | undefined;
    try {
      const app = await this.services();
      if (view.closed) return;
      const summary = await this.summary(app, conversation_id), conversation = await app.tasks.conversation(conversation_id);
      const task = summary.task_id === null ? undefined : await app.tasks.get(summary.task_id);
      const actor = summary.agent_id === null ? task : task?.agents.find((agent) => agent.id === summary.agent_id);
      const model = await app.inference.peek(conversation, actor?.model ?? await app.environment.model(null));
      const native = await app.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
      const imported = await app.histories.byConversation(conversation_id);
      let ready = false; const buffered: RuntimeEventKind[] = [];
      const publish = (event: RuntimeEventKind) => { if (!view.closed) { if (ready) emit(event); else buffered.push(event); } };
      this.attached(id, conversation);
      let working = false;
      stop = await activity(app.harness, conversation, (activity) => publish({ type: "activity", activity }),
        (message) => publish({ type: "message", message }), undefined,
        { includeFinal: true, working(value) { working = value; publish({ type: "conversation_state", working }); } });
      if (view.closed) return;
      emit({ type: "conversation_ready", conversation: summary, model,
        cwd: native?.cwd ?? imported?.thread.cwd ?? "/", working });
      for (const input_id of inputIds) {
        if (view.closed) return;
        for (const event of await reconcileMainInput(conversation, input_id) ?? []) emit(event);
      }
      ready = true; for (const event of buffered) emit(event);
      await finished;
    } finally {
      if (this.views.get(id) === view) this.views.delete(id);
      await stop?.();
    }
  }
  private async host(app: ConversationServices, task: TaskRecord, threadId?: string, cwd = "/"): Promise<WorkerHost> {
    if (task.worker.state !== "unassigned") return app.tasks.workerHost(task.id);
    const available = await app.environment.environment();
    const origins = threadId === undefined ? [] : (await Promise.all(available.nodes.map(async (node) =>
      await app.histories.checkpoint(threadId, node.host_id) === undefined ? undefined : node.host_id))).filter((id) => id !== undefined);
    const hosts = await app.environment.hosts(cwd, null, []);
    const selected = hosts.find((host) => host.host_id !== null && host.host_id !== undefined && origins.includes(host.host_id))
      ?? await app.environment.defaultHost(hosts);
    if (selected === null) throw new TaskError("The saved conversation's execution host is offline; its history is retained.");
    return selected.host_id !== null && selected.host_id !== undefined && origins.includes(selected.host_id) ? { ...selected, cwd } : selected;
  }
  /** No generation occurs here; ordinary task dispatch owns execution and effects. */
  async input(command: Extract<RuntimeCommand, { type: "conversation_input" }>, call: HostCall, emit: Emit): Promise<void> {
    validateInput(command.input, command.attachments);
    const app = await this.services(), summary = await this.summary(app, command.conversation_id);
    if (summary.conversation_id === ROOT_CONVERSATION_ID.toString()) throw new TaskError("The main conversation uses its existing main input path");
    const conversation = await app.tasks.conversation(summary.conversation_id);
    const receipts = await reconcileMainInput(conversation, command.input_id);
    if (receipts !== undefined) {
      for (const event of receipts) emit(event);
      return;
    }
    const imported = await app.histories.byConversation(command.conversation_id);
    let task = summary.task_id === null ? undefined : await app.tasks.get(summary.task_id);
    if (task === undefined && imported !== undefined) {
      task = await app.tasks.adopt(summary.conversation_id, { id: randomUUID(), outcome: "Continue this saved conversation",
        evidence: await app.tasks.readConversation(summary.conversation_id, 24_000), model: await app.inference.peek(conversation, await app.environment.model(null)) });
    }
    if (task === undefined) throw new TaskError("This saved conversation has no task");
    if (summary.agent_id === null) {
      await app.tasks.enqueue(task.id, command.input, command.input_id, undefined, command.mode, command.attachments);
      emit({ type: "input_accepted", input_id: command.input_id });
      const dispatched = await app.tasks.dispatch(task.id, await this.host(app, task, imported?.thread.id, imported?.thread.cwd), call);
      if (dispatched.worker.state !== "bound") throw new TaskError("Session allocation is unconfirmed; its saved input is retained.");
    } else {
      const dispatched = await app.tasks.continueAgent(task.id, summary.agent_id, command.input, command.input_id, call, command.mode,
        () => emit({ type: "input_accepted", input_id: command.input_id }), command.attachments);
      if (dispatched.agents.find((agent) => agent.id === summary.agent_id)?.worker.state !== "bound") {
        throw new TaskError("Agent allocation is unconfirmed; its saved input is retained.");
      }
    }
  }
}
