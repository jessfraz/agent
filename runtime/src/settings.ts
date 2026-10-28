import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationSettings } from "./generated/ConversationSettings.js";
import type { RuntimeCommand } from "./generated/RuntimeCommand.js";
import type { CoordinatorEnvironment } from "./environment.js";
import { ModelError } from "./models.js";
import type { TaskStore } from "./tasks.js";

/** Local controls configure the existing conversation without submitting input. */
export async function conversationSettings(tasks: TaskStore, environment: CoordinatorEnvironment,
  command: Extract<RuntimeCommand, { type: "conversation_settings" }>): Promise<ConversationSettings> {
  if (command.task_id === null && command.agent_id !== null) throw new ModelError("Choose a task for agent settings.");
  const task = command.task_id === null ? undefined : await tasks.get(command.task_id);
  const actor = command.agent_id === null ? task : task?.agents.find((agent) => agent.id === command.agent_id);
  if (task !== undefined && actor === undefined) throw new ModelError("The task agent is unavailable.");
  const conversation = actor === undefined ? await tasks.session.root(BACKGROUND_CONTEXT) : await tasks.conversation(actor.conversation_id);
  const fallback = actor?.model ?? task?.model ?? await environment.model(null);
  const model = await tasks.inference.edit(conversation, fallback, command.change, task === undefined ? undefined :
    (tx, selected) => tasks.updateIn(tx, task.id, (current) => {
      const actor = command.agent_id === null ? current : current.agents.find((agent) => agent.id === command.agent_id);
      if (actor === undefined) throw new ModelError("The task agent is unavailable.");
      actor.model = selected;
    }));
  return { conversation_id: conversation.id.toString(), task_id: task?.id ?? null, agent_id: command.agent_id, model,
    catalog: command.catalog ? tasks.inference.catalog() : [] };
}
