import { fixtureModel } from "../model.js";
import { ConversationModels } from "../../src/models.js";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { TaskStore } from "../../src/tasks.js";

const directory = process.argv[2]; const id = process.argv[3];
if (directory === undefined || id === undefined) throw new Error("Fixture arguments missing");
const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
await database.exec("PRAGMA synchronous = FULL");
const storage = await SqliteStorage.open(database);
const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
const models = createModels(); models.setProvider(faux.provider);
const session = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
const tasks = new TaskStore(session, new ConversationModels(models));
faux.setResponses([async () => {
  while ((await tasks.get(id)).pending.length > 0) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  process.stdout.write("ADMITTED\n");
  return new Promise(() => {});
}]);
await tasks.create({ id, title: "Recover request", outcome: "Finish the original request" });
await tasks.enqueue(id, "Finish the original synthetic request.");
const host = { host_id: null, name: "fixture", rex_server: null, coordinator: null, cwd: "/workspace/example", agent_program: "/example/agent" };
const binding = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
await tasks.dispatch(id, host, async () => ({ type: "spawned", binding }));
const task = await tasks.get(id);
if (task.worker.state !== "bound") throw new Error("Fixture binding missing");
await tasks.run({ type: "run_task", task_id: id, allocation_id: task.worker.allocation_id,
  binding, instructions: "Use the original request.", model: fixtureModel, cwd: host.cwd }, () => () => {}, () => {});
