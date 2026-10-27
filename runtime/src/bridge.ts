import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeRequest } from "./generated/RuntimeRequest.js";
import type { RuntimeEvent } from "./generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ErrorCode } from "./generated/ErrorCode.js";
import { ChatGptAuth } from "./auth.js";
import { validRequest, validEvent, errorEvent } from "./protocol.js";
import { TaskError, TaskStore } from "./tasks.js";
import { createAppTools, Executions, HostRequests } from "./tools.js";
import { createSourceTools, SourceJournal } from "./sources.js";
import { createResourceTools, ResourceStore } from "./resources.js";

const VERSION = 1;
function stateDirectory(): string {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error("State directory is required");
  return directory;
}
const state = stateDirectory();
const auth = new ChatGptAuth(state);
let activeLoginRequestId: number | undefined;
function emit(id: number, event: RuntimeEventKind): void {
  const frame: RuntimeEvent = { version: VERSION, id, event };
  if (!validEvent(frame)) throw new Error("Invalid runtime event");
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
function failure(id: number, code: ErrorCode, message: string): void { emit(id, { type: "failure", code, message }); }
const hostRequests = new HostRequests((id, call_id, command) => emit(id, { type: "host_call", call_id, command }));
const models = createModels();
const upstream = openaiProvider();
models.setProvider({ ...upstream, auth: { apiKey: { name: "ChatGPT plan", async resolve() {
  const credential = await auth.credential();
  return { auth: { apiKey: credential.access }, source: "ChatGPT plan" };
} } } });

async function openApplication() {
  const database = await openNodeSqliteDatabase(join(state, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database);
  const registry = createRegistry();
  const harness = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(harness);
  const executions = new Executions();
  const sources = new SourceJournal(harness, tasks);
  const tools = createAppTools(tasks, executions);
  const sourceTools = createSourceTools(sources, executions);
  const resources = new ResourceStore(harness, tasks);
  tasks.guardResources(resources);
  const resourceTools = createResourceTools(resources, tasks, executions);
  registry.install(tools.host);
  registry.install(tools.main);
  registry.install(tools.worker);
  registry.install(sourceTools);
  registry.install(resourceTools);
  return { harness, tasks, executions, tools, sources, sourceTools, resources, resourceTools };
}
let application: ReturnType<typeof openApplication> | undefined;
function app(): ReturnType<typeof openApplication> { return application ??= openApplication(); }
let mainQueue = Promise.resolve();

async function handle(request: RuntimeRequest): Promise<void> {
  const { id, command } = request;
  try {
    switch (command.type) {
      case "login": {
        try {
          emit(id, { type: "auth_status", status: await auth.login((url) => {
            activeLoginRequestId = id;
            emit(id, { type: "authorization_url", url });
          }, AbortSignal.timeout(180_000)) });
        } finally { if (activeLoginRequestId === id) activeLoginRequestId = undefined; }
        break;
      }
      case "status": emit(id, { type: "auth_status", status: await auth.status() }); break;
      case "logout":
        await auth.logout();
        emit(id, { type: "auth_status", status: await auth.status() });
        break;
      case "list_tasks": emit(id, { type: "tasks", tasks: await (await app()).tasks.list() }); break;
      case "list_resources": emit(id, { type: "resources", resources: await (await app()).resources.list() }); break;
      case "collect_resources": emit(id, { type: "resources", resources: await (await app()).resources.collect(command.host_id, (operation) => hostRequests.call(id, operation)) }); break;
      case "search_tasks": emit(id, { type: "tasks", tasks: await (await app()).tasks.search(command.query) }); break;
      case "read_task": {
        const { tasks } = await app();
        emit(id, { type: "task", task: await tasks.get(command.task_id), history: await tasks.history(command.task_id) });
        break;
      }
      case "source_states": emit(id, { type: "sources", sources: await (await app()).sources.states() }); break;
      case "ingest_source": {
        const result = await (await app()).sources.admit(command.batch, command.expected_checkpoint);
        emit(id, { type: "source_admitted", ...result });
        break;
      }
      case "triage_sources": {
        const { sources, executions, tools, sourceTools, resourceTools } = await app();
        if (await sources.hasWork()) {
          await auth.credential();
          await sources.triage(command, (conversation) => executions.bind(conversation.id.toString(), {
            cwd: command.cwd, hosts: command.hosts, role: "triage", call: (operation) => hostRequests.call(id, operation),
            notify: (task_id, text) => emit(id, { type: "notice", task_id, text }),
          }), [tools.host, tools.main, sourceTools, resourceTools]);
        }
        emit(id, { type: "sources", sources: await sources.states() });
        break;
      }
      case "run_task": {
        await auth.credential();
        const { tasks, executions, tools, sourceTools, resourceTools } = await app();
        const answer = await tasks.run(command, (conversation, host) => executions.bind(conversation.id.toString(), {
          cwd: command.cwd, hosts: [host], role: "worker", call: (operation) => hostRequests.call(id, operation),
        }), (task, text) => emit(id, { type: "notice", task_id: task.id, text: `${task.title}: ${text}` }),
        [tools.host, tools.worker, sourceTools, resourceTools], (operation) => hostRequests.call(id, operation));
        emit(id, { type: "answer", ...answer });
        break;
      }
      case "chat": {
        const turn = mainQueue.then(async () => {
          await auth.credential();
          const { harness, tasks, executions, tools, sourceTools, resourceTools } = await app();
          const root = await harness.root(BACKGROUND_CONTEXT);
          const release = executions.bind(root.id.toString(), {
            cwd: command.cwd, hosts: command.hosts, call: (operation) => hostRequests.call(id, operation),
            notify: (task_id, text) => emit(id, { type: "notice", task_id, text }),
          });
          try {
            const related = await tasks.search(command.input);
            const relatedContext = related.length === 0 ? "" : "\n\nRelated existing tasks (read and reuse the matching task):\n" +
              JSON.stringify(related.map((task) => ({ id: task.id, title: task.title, outcome: task.outcome, state: task.state, summary: task.summary })));
            const hostsContext = "\n\nConfigured worker hosts (first is default): " +
              JSON.stringify(command.hosts.map((host) => ({ name: host.name, cwd: host.cwd })));
            await root.configure({ model: { provider: "openai", modelId: command.model },
              instructions: command.instructions + relatedContext + hostsContext, cwd: command.cwd, extensions: [tools.host, tools.main, sourceTools, resourceTools] }, BACKGROUND_CONTEXT);
            const submission = await root.submit({ type: "input", content: command.input }, BACKGROUND_CONTEXT);
            const settled = await submission.wait(BACKGROUND_CONTEXT);
            if (settled.type !== "input" || settled.status !== "done") throw new TaskError("The model turn did not complete; its state is retained");
            const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
            const text = entry?.model?.flatMap((message) => message.role !== "assistant" ? []
              : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n") ?? "";
            emit(id, { type: "answer", conversation_id: root.id.toString(), text });
          } finally { release(); }
        });
        mainQueue = turn.then(() => {}, () => {});
        await turn;
        break;
      }
      case "host_reply": break;
      default: throw new TaskError("This request is handled by the coordinator");
    }
  } catch (error) {
    if (error instanceof TaskError) failure(id, "invalid_request", error.message);
    else emit(id, errorEvent(error));
  } finally {
    hostRequests.finish(id);
    emit(id, { type: "done" });
  }
}

const pending = new Set<Promise<void>>();
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request: unknown;
    try { request = JSON.parse(line); } catch {
      failure(0, "invalid_request", "Invalid protocol frame"); emit(0, { type: "done" }); continue;
    }
    if (!validRequest(request)) {
      failure(0, "invalid_request", "Invalid protocol frame"); emit(0, { type: "done" }); continue;
    }
    if (request.version !== VERSION) {
      failure(request.id, "invalid_request", "Unsupported protocol version"); emit(request.id, { type: "done" }); continue;
    }
    if (request.command.type === "host_reply") {
      hostRequests.reply(request.id, request.command.call_id, request.command.result);
      continue;
    }
    if (request.command.type === "oauth_callback") {
      if (activeLoginRequestId === request.id) auth.forwardCallback(request.command.target);
      continue;
    }
    if (pending.size >= 64) {
      failure(request.id, "invalid_request", "The coordinator is busy; retry later"); emit(request.id, { type: "done" }); continue;
    }
    const operation = handle(request).finally(() => pending.delete(operation));
    pending.add(operation);
  }
  await Promise.allSettled(pending);
} finally {
  if (application !== undefined) {
    const opened = await application.catch(() => undefined);
    if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
  }
}
