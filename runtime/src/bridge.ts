import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeRequest } from "./generated/RuntimeRequest.js";
import type { RuntimeEvent } from "./generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ErrorCode } from "./generated/ErrorCode.js";
import { CoordinatorEnvironment, EnvironmentError } from "./environment.js";
import { ConversationModels, ModelError } from "./models.js";
import { ChatGptAuth } from "./auth.js";
import { validRequest, validEvent, errorEvent } from "./protocol.js";
import { TaskError, TaskStore, type HostCall } from "./tasks.js";
import { HistoryStore } from "./history.js";
import { CodexImporter } from "./importer.js";
import { Retrieval } from "./retrieval.js";
import { createGuidance } from "./guidance.js";
import { createAppTools, Executions, HostRequests } from "./tools.js";
import { createSourceTools, SourceJournal } from "./sources.js";
import { createResourceTools, ResourceStore } from "./resources.js";
import { activity, history } from "./transcript.js";
import type { RuntimeCommand } from "./generated/RuntimeCommand.js";

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
const hostRequests = new HostRequests((id, call_id, command) => emit(id, { type: "host_call", call_id, command }),
  (id, call_id) => emit(id, { type: "host_cancel", call_id }));
const inference = new ConversationModels(undefined, auth);
const models = inference.models;

async function openApplication() {
  const database = await openNodeSqliteDatabase(join(state, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database);
  const registry = createRegistry();
  const harness = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(harness, inference);
  const environment = new CoordinatorEnvironment(harness); environment.useLiveGuidance(); tasks.useEnvironment(environment);
  const assets = join(state, "history", "assets");
  const histories = new HistoryStore(harness, assets); tasks.useHistory(histories);
  const importer = new CodexImporter(harness, histories, assets);
  const retrieval = new Retrieval(harness, histories, tasks, join(state, "search.sqlite"));
  const executions = new Executions();
  const sources = new SourceJournal(harness, tasks, executions);
  const tools = createAppTools(tasks, executions);
  const guidance = createGuidance(executions); registry.install(guidance);
  const sourceTools = createSourceTools(sources, executions);
  const resources = new ResourceStore(harness, tasks);
  tasks.guardResources(resources);
  const resourceTools = createResourceTools(resources, tasks, executions);
  registry.install(tools.host);
  registry.install(tools.main);
  registry.install(tools.worker);
  registry.install(sourceTools);
  registry.install(resourceTools);
  return { harness, tasks, environment, executions, tools, sources, sourceTools, resources, resourceTools, histories, importer, retrieval, guidance };
}
let application: ReturnType<typeof openApplication> | undefined;
function app(): ReturnType<typeof openApplication> { return application ??= openApplication(); }
let mainQueue = Promise.resolve();
const activeConversations = new Map<number, import("@earendil-works/pi-durable").Conversation>();
const activeCommands = new Set<number>();
const interrupted = new Set<number>();
const interrupts = new Map<number, Promise<void>>();
const workers = new Map<number, { command: Extract<RuntimeCommand, { type: "run_task" }>; controller: AbortController }>();

function searchFor(application: Awaited<ReturnType<typeof openApplication>>, id: number) {
  return (query: string, refs: string[], limit: number) => application.retrieval.search(query, refs, limit,
    (command) => hostRequests.call(id, command), application.importer.isRunning());
}
async function interrupt(id: number): Promise<void> {
  interrupted.add(id);
  if (interrupts.has(id)) return interrupts.get(id);
  hostRequests.cancelRequest(id);
  const conversation = activeConversations.get(id);
  if (conversation === undefined) return;
  const operation = (async () => { await conversation.abort(BACKGROUND_CONTEXT); emit(id, { type: "interrupted" }); })();
  interrupts.set(id, operation); await operation;
}
async function handle(request: RuntimeRequest): Promise<void> {
  const { id, command } = request;
  if (command.type === "chat" || command.type === "run_task") activeCommands.add(id);
  if (command.type === "run_task" && command.interactive === true) {
    workers.set(id, { command, controller: new AbortController() });
  }
  try {
    switch (command.type) {
      case "configure_coordinator":
        await (await app()).environment.configure(command.bootstrap); emit(id, { type: "configured" }); break;
      case "register_node":
        await (await app()).environment.register(command.node); emit(id, { type: "node_registered", host_id: command.node.host_id }); break;
      case "set_connected_nodes":
        (await app()).environment.setConnected(command.host_ids); emit(id, { type: "configured" }); break;
      case "environment": emit(id, await (await app()).environment.environment()); break;
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
      case "import_codex": {
        const application = await app(); const available = await application.environment.environment();
        await application.importer.run(available.nodes, available.online_host_ids, command.hosts,
          (operation) => hostRequests.call(id, operation), (progress) => emit(id, { type: "import_progress", progress }),
          () => application.retrieval.sync((operation) => hostRequests.call(id, operation), true));
        break;
      }
      case "import_status": emit(id, { type: "import_progress", progress: await (await app()).importer.status() }); break;
      case "search_history": {
        const application = await app();
        const result = await application.tasks.find(command.query, [], command.limit, searchFor(application, id));
        emit(id, { type: "saved_matches", ...result }); break;
      }
      case "read_conversation": {
        for (const frame of await history(await (await app()).tasks.conversation(command.conversation_id), command.cursor)) emit(id, frame);
        break;
      }
      case "open_conversation": {
        const application = await app(); const { tasks, environment } = application;
        const imported = await tasks.saved(command.conversation_id);
        let task = (await tasks.list()).find((task) => task.conversation_id === command.conversation_id);
        if (task === undefined && imported !== undefined) task = await tasks.adopt(command.conversation_id, {
          id: randomUUID(), outcome: "Continue this historical conversation", evidence: await tasks.readConversation(command.conversation_id, 24_000), model: await environment.model(null),
        });
        if (task === undefined) throw new TaskError("This conversation has no task; run agent chat for the main conversation");
        const hosts = await environment.hosts("/", null, []);
        const host = task.worker.state === "bound" ? await tasks.workerHost(task.id)
          : command.host === null ? await environment.defaultHost(hosts)
          : hosts.find((host) => host.name === command.host || host.host_id === command.host);
        if (host === null || host === undefined) throw new TaskError("Choose an online execution host");
        const opened = await tasks.dispatch(task.id, host, (operation) => hostRequests.call(id, operation));
        if (opened.worker.state !== "bound") throw new TaskError("Rex session allocation is unconfirmed; saved history is retained");
        emit(id, { type: "notice", task_id: task.id, text: `Opened ${task.title}` }); break;
      }
      case "list_tasks": emit(id, { type: "tasks", tasks: await (await app()).tasks.list() }); break;
      case "list_resources": emit(id, { type: "resources", resources: await (await app()).resources.list() }); break;
      case "collect_resources": emit(id, { type: "resources", resources: await (await app()).resources.collect(command.host_id, (operation) => hostRequests.call(id, operation)) }); break;
      case "search_tasks": emit(id, { type: "tasks", tasks: await (await app()).tasks.search(command.query) }); break;
      case "read_task": {
        const { tasks } = await app();
        emit(id, { type: "task", task: await tasks.get(command.task_id), history: await tasks.history(command.task_id) });
        break;
      }
      case "read_history": {
        const { harness, tasks } = await app();
        if (command.task_id === null && command.agent_id !== null) throw new TaskError("Choose a task for agent history");
        const conversation = command.task_id === null ? await harness.root(BACKGROUND_CONTEXT)
          : await tasks.conversation(command.agent_id === null ? (await tasks.get(command.task_id)).conversation_id
            : (await tasks.get(command.task_id)).agents.find((agent) => agent.id === command.agent_id)?.conversation_id ?? "");
        for (const frame of await history(conversation, command.cursor)) emit(id, frame);
        break;
      }
      case "revoke_allocation": {
        const { tasks } = await app();
        const task = await tasks.revokeAllocation(command.task_id, command.allocation_id, command.agent_id);
        emit(id, { type: "task", task, history: await tasks.history(command.task_id) });
        break;
      }
      case "source_states": emit(id, { type: "sources", sources: await (await app()).sources.states() }); break;
      case "ingest_source": {
        const result = await (await app()).sources.admit(command.batch, command.expected_checkpoint);
        emit(id, { type: "source_admitted", ...result });
        break;
      }
      case "triage_sources": {
        const application = await app();
        const { sources, environment, executions, tools, sourceTools, resourceTools, guidance } = application;
        if (await sources.hasWork()) {
          const hosts = await environment.hosts(command.cwd, null, command.hosts);
          const default_host = await environment.defaultHost(hosts);
          await sources.triage({ ...command, hosts }, (conversation, model) => executions.bind(conversation.id.toString(), {
            model, cwd: command.cwd, hosts, default_host, role: "triage", search: searchFor(application, id), call: (operation) => hostRequests.call(id, environment.route(operation, default_host)),
            notify: (task_id, text) => emit(id, { type: "notice", task_id, text }),
          }), [guidance, tools.host, tools.main, sourceTools, resourceTools]);
        }
        emit(id, { type: "sources", sources: await sources.states() });
        break;
      }
      case "run_task": {
        const application = await app();
        const { tasks, executions, tools, sourceTools, resourceTools, guidance } = application;
        let stop: (() => Promise<void>) | undefined;
        try {
        const worker = workers.get(id);
        const answer = await tasks.run(command, (conversation, host, model) => executions.bind(conversation.id.toString(), {
          model, cwd: command.cwd, hosts: [host], role: "worker", search: searchFor(application, id), call: (operation) => hostRequests.call(id, operation),
        }), (task, text) => emit(id, { type: "notice", task_id: task.id, text: `${task.title}: ${text}` }),
        [guidance, tools.host, tools.worker, sourceTools, resourceTools], (operation) => hostRequests.call(id, operation), (selected) => inference.preflight(selected),
        worker === undefined ? undefined : {
          signal: worker.controller.signal,
          async fence() { await interrupt(id); },
          async beforeTurn() {
            for (;;) {
              const stopping = interrupts.get(id);
              if (stopping === undefined) return;
              await stopping;
              if (interrupts.get(id) !== stopping) continue;
              interrupts.delete(id); interrupted.delete(id); hostRequests.resumeRequest(id);
            }
          },
          async ready(conversation, title) {
            activeConversations.set(id, conversation);
            if (interrupted.has(id)) await interrupt(id);
            emit(id, { type: "task_ready", conversation_id: conversation.id.toString(), title });
            for (const frame of await history(conversation, null)) emit(id, frame);
            stop = await activity(tasks.session, conversation, (activity) => emit(id, { type: "activity", activity }),
              (message) => emit(id, { type: "message", message }));
          },
          answer(conversation_id, text) { emit(id, { type: "answer", conversation_id, text }); },
          idle() { emit(id, { type: "worker_idle" }); },
        });
        if (worker === undefined) emit(id, { type: "answer", ...answer });
        } finally { await stop?.(); }
        break;
      }
      case "chat": {
        const turn = mainQueue.then(async () => {
          if (interrupted.has(id)) { emit(id, { type: "interrupted" }); return; }
          const selected = command.model ?? await (await app()).environment.model(null);
          await inference.preflight(selected);
          const application = await app();
          const { harness, tasks, environment, executions, tools, sourceTools, resourceTools, guidance } = application;
          const hosts = await environment.hosts(command.cwd, command.origin_host_id, command.hosts);
          const default_host = await environment.defaultHost(hosts);
          const root = await harness.root(BACKGROUND_CONTEXT);
          activeConversations.set(id, root);
          if (interrupted.has(id)) { emit(id, { type: "interrupted" }); return; }
          await root.waitForIdle(BACKGROUND_CONTEXT);
          if (interrupted.has(id)) { await interrupts.get(id); return; }
          const release = executions.bind(root.id.toString(), {
            model: selected, cwd: command.cwd, hosts, default_host, search: searchFor(application, id),
            project: () => hostRequests.call(id, command.origin_host_id === null
              ? { type: "project_guidance", cwd: command.cwd }
              : { type: "on_node", host_id: command.origin_host_id, command: { type: "project_guidance", cwd: command.cwd } }), call: (operation) => hostRequests.call(id, environment.route(operation, default_host)),
            notify: (task_id, text) => emit(id, { type: "notice", task_id, text }),
          });
          const stop = await activity(harness, root, (activity) => emit(id, { type: "activity", activity }));
          try {
            const related = await tasks.find(command.input, [], 8, searchFor(application, id));
            if (interrupted.has(id)) { await interrupts.get(id); return; }
            const relatedContext = related.matches.length === 0 && related.gaps.length === 0 ? "" : "\n\nRelated saved conversations and retrieval coverage (read and reuse matching work):\n" +
              JSON.stringify(related);
            const hostsContext = "\n\nConnected worker hosts: " +
              JSON.stringify({ default_host_id: default_host?.host_id ?? null, origin_host_id: command.origin_host_id, project_cwd: command.cwd,
                hosts: hosts.map((host) => ({ host_id: host.host_id, name: host.name, cwd: host.cwd })) });
            await inference.configure(root, selected, {
              instructions: (await environment.instructions(command.instructions)) + relatedContext + hostsContext, cwd: command.cwd, extensions: [guidance, tools.host, tools.main, sourceTools, resourceTools] });
            if (interrupted.has(id)) { await interrupts.get(id); return; }
            const submission = await root.submit({ type: "input", content: command.input }, BACKGROUND_CONTEXT);
            const settled = await submission.wait(BACKGROUND_CONTEXT);
            if (settled.type === "input" && settled.status === "unanswered" && settled.reason === "aborted") { await interrupts.get(id); return; }
            if (settled.type !== "input" || settled.status !== "done") throw new TaskError("The model turn did not complete; its state is retained");
            const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
            const text = entry?.model?.flatMap((message) => message.role !== "assistant" ? []
              : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n") ?? "";
            emit(id, { type: "answer", conversation_id: root.id.toString(), text });
          } finally { await stop(); release(); }
        });
        mainQueue = turn.then(() => {}, () => {});
        await turn;
        break;
      }
      case "host_reply": break;
      default: throw new TaskError("This request is handled by the coordinator");
    }
  } catch (error) {
    if (interrupted.has(id)) {
      const stopping = interrupts.get(id);
      if (stopping === undefined) emit(id, { type: "interrupted" });
      else await stopping.catch(() => failure(id, "internal", "Interruption could not be confirmed; inspect current work"));
    }
    else if (error instanceof TaskError || error instanceof ModelError || error instanceof EnvironmentError) failure(id, "invalid_request", error.message);
    else emit(id, errorEvent(error));
  } finally {
    await interrupts.get(id)?.catch(() => {});
    activeCommands.delete(id); activeConversations.delete(id); interrupted.delete(id); interrupts.delete(id);
    workers.delete(id);
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
    if (request.command.type === "interrupt") {
      // Done may already be buffered while Rust still owns the request and sends its last control.
      if (!activeCommands.has(request.id)) continue;
      void interrupt(request.id).catch(() => {
        if (activeCommands.has(request.id)) failure(request.id, "internal", "Interruption could not be confirmed; inspect current work");
      });
      continue;
    }
    if (request.command.type === "host_reply") {
      hostRequests.reply(request.id, request.command.call_id, request.command.result);
      continue;
    }
    if (request.command.type === "oauth_callback") {
      if (activeLoginRequestId === request.id) auth.forwardCallback(request.command.target);
      continue;
    }
    if (request.command.type === "worker_input" || request.command.type === "detach_worker") {
      const worker = workers.get(request.id);
      if (worker === undefined) continue;
      if (request.command.type === "detach_worker") worker.controller.abort();
      else {
        const { input, input_id } = request.command;
        try {
          if (worker.controller.signal.aborted) throw new TaskError("This worker is detaching");
          await (await app()).tasks.input(worker.command, input, input_id);
        } catch (error) {
          emit(request.id, { type: "input_rejected", input_id,
            message: error instanceof TaskError ? error.message : "Input could not be saved; its previous history is retained" });
        }
      }
      continue;
    }
    if (pending.size >= 64) {
      failure(request.id, "invalid_request", "The coordinator is busy; retry later"); emit(request.id, { type: "done" }); continue;
    }
    const operation = handle(request).finally(() => pending.delete(operation));
    pending.add(operation);
  }
  for (const worker of workers.values()) worker.controller.abort();
  await Promise.allSettled(pending);
} finally {
  if (application !== undefined) {
    const opened = await application.catch(() => undefined);
    if (opened !== undefined) { opened.retrieval.close(); await opened.harness.close(BACKGROUND_CONTEXT); }
  }
}
