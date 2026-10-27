import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { TaskStore } from "../../src/tasks.js";
import { createAppTools, Executions } from "../../src/tools.js";
import { createSourceTools, SourceJournal } from "../../src/sources.js";

const directory = process.argv[2]; if (directory === undefined) throw new Error("Fixture state directory missing");
const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
await database.exec("PRAGMA synchronous = FULL");
const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
const models = createModels(); models.setProvider(faux.provider); const registry = createRegistry();
const session = await Harness.open(await SqliteStorage.open(database), { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
const tasks = new TaskStore(session); const executions = new Executions(); const sources = new SourceJournal(session, tasks);
const tools = createAppTools(tasks, executions); const sourceTools = createSourceTools(sources, executions);
registry.install(tools.host); registry.install(tools.main); registry.install(sourceTools);
await sources.admit({ source: { provider: "mail", account: "alpha" }, checkpoint: { value: "a1" }, coverage: { status: "complete" },
  events: [{ id: "original", version: "v1", source: { provider: "mail", account: "alpha", thread_id: "original-thread" },
    title: "Original confirmation", text: "This source must not be lost or resubmitted." },
  { id: "remaining", version: "v1", source: { provider: "mail", account: "alpha", thread_id: "remaining-thread" },
    title: "Remaining confirmation", text: "This source stays pending after partial judgment." }] }, null);
const first = (await sources.events({ query: "Original confirmation" }))[0];
if (first === undefined) throw new Error("Fixture event missing");
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("dismiss_source_events", { keys: [first.key], reason: "First item accounted for" }), { stopReason: "toolUse" }),
  async () => { process.stdout.write("ADMITTED\n"); return new Promise(() => {}); },
]);
await sources.triage({ type: "triage_sources", instructions: "Account for each event.", model: "fixture", cwd: "/workspace/example", hosts: [] },
  (conversation) => executions.bind(conversation.id.toString(), { cwd: "/workspace/example", hosts: [], role: "triage", call: async () => ({ type: "written" }) }),
  [tools.host, tools.main, sourceTools]);
