import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CoordinatorEnvironment } from "./environment.js";
import type { FeedbackStore } from "./feedback.js";
import type { FeedbackBundle } from "./generated/FeedbackBundle.js";
import type { FeedbackReceipt } from "./generated/FeedbackReceipt.js";
import { TaskError, type HostCall, type TaskStore } from "./tasks.js";

/** Feedback reuses a repair conversation on its originating node, never the coordinator by default. */
export class FeedbackDispatcher {
  private readonly launching = new Map<string, Promise<FeedbackReceipt>>();
  constructor(private readonly store: FeedbackStore, private readonly tasks: TaskStore,
    private readonly environment: CoordinatorEnvironment) {}

  async dispatch(bundle: FeedbackBundle, call: HostCall): Promise<FeedbackReceipt> {
    const origin = bundle.context.origin_host_id;
    const previous = this.launching.get(origin) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.launch(bundle, call));
    this.launching.set(origin, operation);
    try { return await operation; }
    finally { if (this.launching.get(origin) === operation) this.launching.delete(origin); }
  }

  private async launch(bundle: FeedbackBundle, call: HostCall): Promise<FeedbackReceipt> {
    const context = bundle.context;
    if (context.binding !== null && context.binding.host_id !== context.origin_host_id) {
      throw new TaskError(`Feedback ${bundle.id} was saved, but its terminal belongs to another machine.`);
    }
    const source = { provider: "agent_feedback", account: "local", thread_id: context.origin_host_id };
    let task = (await this.tasks.list()).find((task) => task.sources.some((saved) =>
      saved.provider === source.provider && saved.account === source.account && saved.thread_id === source.thread_id));
    if (task !== undefined) {
      const conversation = await this.tasks.conversation(task.conversation_id);
      const submitted = await this.tasks.session.commit((tx) => tx.submissionByRequest(conversation.id, "feedback:" + bundle.id), BACKGROUND_CONTEXT);
      if (submitted !== undefined || (task.worker.state === "bound" && task.pending.some((input) => input.id === "feedback:" + bundle.id))) {
        return { id: bundle.id, path: this.store.path(bundle.id), task_id: task.id, agent_id: null };
      }
    }
    const host = (await this.environment.hosts(context.cwd, context.origin_host_id, []))
      .find((host) => host.host_id === context.origin_host_id);
    if (host === undefined) throw new TaskError(`Feedback ${bundle.id} was saved, but its originating machine is offline.`);
    if (task === undefined) {
      const model = context.model ?? host.launch?.model ?? await this.environment.model(null);
      await this.tasks.inference.preflight(model);
      task = await this.tasks.create({ title: "Beep Boop feedback", outcome: "Fix reported Beep Boop behavior and report verified results in the main chat.",
        sources: [source], model });
    }
    const taskId = task.id;
    const input = "Investigate and fix this feedback in the relevant existing checkout on this machine; validate the change and report the verified result. " +
      `Read agent --json feedback show ${bundle.id} for the private diagnostic context. Keep that context private and preserve unrelated work.\n\n` +
      "User feedback: " + bundle.description;
    await this.tasks.enqueue(taskId, input, "feedback:" + bundle.id, undefined, undefined, bundle.context.attachments);
    const dispatched = await this.tasks.dispatch(taskId, host, (command) => call(command.type === "spawn_worker" &&
      command.task_id === taskId && context.binding !== null ? { ...command, parent: context.binding } : command));
    if (dispatched.worker.state !== "bound") {
      throw new TaskError(`Feedback ${bundle.id} is retained on task ${taskId}, but its debugging terminal was not confirmed.`);
    }
    return { id: bundle.id, path: this.store.path(bundle.id), task_id: taskId, agent_id: null };
  }
}
