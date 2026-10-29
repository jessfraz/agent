import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ConversationSettings } from "./generated/ConversationSettings.js";
import type { RuntimeCommand } from "./generated/RuntimeCommand.js";
import type { CoordinatorEnvironment } from "./environment.js";
import { ModelError } from "./models.js";
import type { TaskStore } from "./tasks.js";

/** Local controls configure the existing conversation without submitting input. */
export async function conversationSettings(tasks: TaskStore, environment: CoordinatorEnvironment,
  command: Extract<RuntimeCommand, { type: "conversation_settings" }>): Promise<ConversationSettings> {
  if (command.task_id === null && command.agent_id !== null) throw new ModelError("Choose a task for agent settings.");
  let task = command.task_id === null ? undefined : await tasks.get(command.task_id);
  let agentId = command.agent_id;
  if (command.conversation_id !== undefined && task === undefined && command.conversation_id !== ROOT_CONVERSATION_ID.toString()) {
    const owner = (await tasks.list()).find((item) => item.conversation_id === command.conversation_id ||
      item.agents.some((agent) => agent.conversation_id === command.conversation_id));
    if (owner !== undefined) {
      task = owner; agentId = owner.conversation_id === command.conversation_id ? null
        : owner.agents.find((agent) => agent.conversation_id === command.conversation_id)?.id ?? null;
    } else if (await tasks.saved(command.conversation_id) === undefined) throw new ModelError("Choose an existing saved conversation.");
  }
  const actor = agentId === null ? task : task?.agents.find((agent) => agent.id === agentId);
  if (task !== undefined && actor === undefined) throw new ModelError("The task agent is unavailable.");
  if (actor !== undefined && command.conversation_id !== undefined && actor.conversation_id !== command.conversation_id) {
    throw new ModelError("The saved conversation does not belong to this task agent.");
  }
  const conversation = actor !== undefined ? await tasks.conversation(actor.conversation_id) : command.conversation_id !== undefined
    ? await tasks.conversation(command.conversation_id) : await tasks.session.root(BACKGROUND_CONTEXT);
  const fallback = actor?.model ?? task?.model ?? await environment.model(null);
  const model = command.change === null ? await tasks.inference.peek(conversation, fallback)
    : await tasks.inference.edit(conversation, fallback, command.change, task === undefined ? undefined :
    (tx, selected) => tasks.updateIn(tx, task.id, (current) => {
      const actor = agentId === null ? current : current.agents.find((agent) => agent.id === agentId);
      if (actor === undefined) throw new ModelError("The task agent is unavailable.");
      actor.model = selected;
    }));
  return { conversation_id: conversation.id.toString(), task_id: task?.id ?? null, agent_id: agentId, model,
    catalog: command.catalog ? tasks.inference.catalog() : [] };
}
