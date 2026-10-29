import { join } from "node:path";
import { AttachmentStore, AttachmentError, validateInput } from "./attachments.js";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { AssistantEntry, createRegistry, Harness, ROOT_CONVERSATION_ID, type Conversation, type Submission } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeRequest } from "./generated/RuntimeRequest.js";
import type { RuntimeEvent } from "./generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ErrorCode } from "./generated/ErrorCode.js";
import { CoordinatorEnvironment, EnvironmentError } from "./environment.js";
import { ConversationModels, ModelError, modelFailureMessage } from "./models.js";
import { ChatGptAuth } from "./auth.js";
import { validRequest, validEvent, errorEvent, invalidHostReply, protocolLines } from "./protocol.js";
import { TaskError, TaskStore, type HostCall } from "./tasks.js";
import { HistoryStore } from "./history.js";
import { CodexImporter } from "./importer.js";
import { ConversationCatalog } from "./catalog.js";
import { ConversationViews } from "./conversation-views.js";
import { Retrieval } from "./retrieval.js";
import { FeedbackStore } from "./feedback.js";
import { FeedbackDispatcher } from "./feedback-dispatch.js";
import { createGuidance } from "./guidance.js";
import { createAppTools, createJobTools, Executions, HostRequests } from "./tools.js";
import { createToolsets, type Toolsets } from "./toolsets.js";
import { createSourceTools, SourceJournal } from "./sources.js";
import { createResourceTools, ResourceStore } from "./resources.js";
import { BrowserStore, createBrowserTools } from "./browser.js";
import { activity, history, toolDetails } from "./transcript.js";
import type { SearchMode } from "./generated/SearchMode.js";
import type { RuntimeCommand } from "./generated/RuntimeCommand.js";
import { conversationSettings } from "./settings.js";
import { watchInputPlacements } from "./input_delivery.js";
import { reconcileMainInput, watchMainNotices } from "./main_observation.js";
import { BackgroundScheduler } from "./background.js";
import { openJobActor, runScheduled } from "./scheduled.js";
import type { SourcePollCursor } from "./generated/SourcePollCursor.js";

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
  // Text deltas are an ObserveMain opt-in. Existing Chat clients deserialize a
  // closed event enum and must keep receiving their original canonical wire.
  if (event.type !== "text_delta" || mainObservers.has(id)) process.stdout.write(`${JSON.stringify(frame)}\n`);
  if (mainTurns.has(id)) {
    for (const [observerId, observer] of mainObservers) {
      const update = event.type === "done" ? { type: "worker_idle" } satisfies RuntimeEventKind : event;
      if (["main_ready", "text_delta", "activity", "message", "answer", "input_accepted", "input_placed", "input_rejected", "interrupted", "failure", "conversation_settings", "worker_idle"].includes(update.type)) {
        queueMainObserver(observerId, observer, update);
      }
    }
  }
  for (const [viewId, view] of mainViews) {
    if (view.owner !== id) continue;
    if (event.type === "done") view.finish();
    else if (view.live && ["activity", "message", "answer", "input_accepted", "input_placed", "input_rejected", "interrupted", "failure", "conversation_settings"].includes(event.type)) {
      // Views observe the existing execution. Native effects and notices keep
      // their original owner so reconnecting never executes a tool twice.
      const mirrored: RuntimeEvent = { version: VERSION, id: viewId, event };
      process.stdout.write(`${JSON.stringify(mirrored)}\n`);
    }
  }
}
function failure(id: number, code: ErrorCode, message: string): void { emit(id, { type: "failure", code, message }); }
const hostRequests = new HostRequests((id, call_id, command) => emit(id, { type: "host_call", call_id, command }),
  (id, call_id) => emit(id, { type: "host_cancel", call_id }));
const inference = new ConversationModels(undefined, auth);
const models = inference.models;
let backgroundOwner: number | undefined;
let backgroundSources = false;
let stopBackground: (() => void) | undefined;
function backgroundCall(command: import("./generated/HostCommand.js").HostCommand) {
  if (backgroundOwner === undefined) throw new TaskError("The coordinator background transport is unavailable");
  return hostRequests.call(backgroundOwner, command);
}

type Application = TriageApplication & { stopPlacements(): void; harness: Harness; tasks: TaskStore; resources: ResourceStore;
  histories: HistoryStore; catalog: ConversationCatalog; attachments: AttachmentStore; feedback: FeedbackStore; repairs: FeedbackDispatcher; background: BackgroundScheduler };
async function openApplication(): Promise<Application> {
  const database = await openNodeSqliteDatabase(join(state, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database);
  const registry = createRegistry();
  const harness = await Harness.open(storage, { models, registry, identity: { attribution: null },
    settings: { steeringMode: "all", followUpMode: "one-at-a-time" } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(harness, inference);
  const attachments = new AttachmentStore(state); tasks.useAttachments(attachments);
  const environment = new CoordinatorEnvironment(harness); environment.useLiveGuidance(); tasks.useEnvironment(environment);
  const assets = join(state, "history", "assets");
  const histories = new HistoryStore(harness, assets); tasks.useHistory(histories);
  const catalog = new ConversationCatalog(harness, histories, tasks);
  const importer = new CodexImporter(harness, histories, assets);
  const retrieval = new Retrieval(harness, histories, tasks, join(state, "search.sqlite"));
  const feedback = new FeedbackStore(state, tasks);
  const repairs = new FeedbackDispatcher(feedback, tasks, environment);
  const executions = new Executions();
  await executions.prepareRecovery(harness);
  const sources = new SourceJournal(harness, tasks, executions);
  const tools = createAppTools(tasks, executions);
  const guidance = createGuidance(executions); registry.install(guidance);
  const sourceTools = createSourceTools(sources, executions);
  const resources = new ResourceStore(harness, tasks);
  tasks.guardResources(resources);
  const resourceTools = createResourceTools(resources, tasks, executions);
  const browserTools = createBrowserTools(new BrowserStore(harness), executions);
  registry.install(tools.host);
  registry.install(tools.main);
  registry.install(tools.legacy);
  registry.install(tools.worker);
  registry.install(tools.agent);
  registry.install(sourceTools.main);
  registry.install(sourceTools.worker);
  registry.install(resourceTools.main);
  registry.install(resourceTools.worker);
  registry.install(browserTools);
  const stopPlacements = watchInputPlacements(harness, (conversationId, input_id, entry_id) => {
    for (const [id, conversation] of activeConversations) {
      if (conversation.id.toString() === conversationId && !ending.has(id)) emit(id, { type: "input_placed", input_id, entry_id });
    }
  });
  const core = { stopPlacements, harness, tasks, environment, executions, sources, resources, histories, catalog, importer, retrieval, attachments, feedback, repairs };
  const background = new BackgroundScheduler(harness, registry, tasks, {
    async plan(cadence, after, now) {
      const result = await backgroundCall({ type: "background", request: { type: "plan", cadence, after, now } });
      if (result.type !== "background" || result.response.type !== "plan") throw new TaskError("The Rust background planner is unavailable");
      return result.response.plan;
    },
    async refreshSources() {
      if (!backgroundSources) return;
      const settings = (await environment.environment()).settings;
      let cursor: SourcePollCursor | null = null;
      do {
        const result = await backgroundCall({ type: "background", request: { type: "poll_sources", sources: settings.sources, states: await sources.states(), cursor } });
        if (result.type !== "background" || result.response.type !== "sources") throw new TaskError("Background source coverage could not be read");
        for (const read of result.response.reads) await sources.admit(read.batch, read.expected_checkpoint);
        cursor = result.response.cursor;
      } while (cursor !== null);
      if (backgroundOwner !== undefined) await triageSources(await app(), backgroundOwner, { type: "triage_sources", instructions: "", model: settings.model, cwd: "/", hosts: [] });
    },
    async collectResources() {
      const available = await environment.environment();
      const host = await environment.defaultHost(await environment.hosts("/", null, []));
      if (host?.host_id !== null && host?.host_id !== undefined && available.online_host_ids.includes(host.host_id)) {
        await resources.collect(host.host_id, backgroundCall);
      }
    },
    jobActor: (job) => openJobActor(job, tasks, backgroundCall),
    async runJob(occurrence, signal, actor) { await runScheduled(occurrence, signal, { session: harness, tasks, sources, environment, executions, call: backgroundCall }, actor); },
  });
  const jobTools = createJobTools(background, executions); registry.install(jobTools);
  const toolsets = createToolsets({ guidance, tools, sourceTools, resourceTools, browserTools, jobTools });
  return { ...core, background, toolsets };
}
let application: ReturnType<typeof openApplication> | undefined;
function app(): ReturnType<typeof openApplication> { return application ??= openApplication(); }
let mainQueue = Promise.resolve();
const activeConversations = new Map<number, import("@earendil-works/pi-durable").Conversation>();
const conversationViews = new ConversationViews(async () => ({ ...await app(), inference }),
  (request, conversation) => activeConversations.set(request, conversation));
const activeCommands = new Set<number>();
const interrupted = new Set<number>();
const interrupts = new Map<number, Promise<void>>();
const workers = new Map<number, { command: Extract<RuntimeCommand, { type: "run_task" }>; controller: AbortController }>();
type MainTurn = { conversation?: Conversation; accepting: boolean; admissions: number; wake?: () => void;
  info?: Extract<RuntimeEventKind, { type: "main_ready" }>;
  ready: Promise<boolean>; start(ready: boolean): void; inputs: { input_id?: string; submission: Submission }[] };
function mainTurn(): MainTurn {
  let start = (_ready: boolean) => {};
  const ready = new Promise<boolean>((resolve) => { start = resolve; });
  return { ready, start, accepting: true, admissions: 0, inputs: [] };
}
const mainTurns = new Map<number, MainTurn>();
const mainViews = new Map<number, { owner: number; live: boolean; finish(): void }>();
type MainObserver = { buffer?: RuntimeEventKind[]; bytes: number; overflow: boolean; finish(): void };
const mainObservers = new Map<number, MainObserver>();
function queueMainObserver(id: number, observer: MainObserver, event: RuntimeEventKind): void {
  if (observer.overflow) return;
  if (observer.buffer === undefined) { emit(id, event); return; }
  observer.bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
  if (observer.buffer.length >= 512 || observer.bytes > 4 * 1024 * 1024) {
    observer.overflow = true; observer.finish(); return;
  }
  observer.buffer.push(event);
}
const inputControls = new Map<number, Set<Promise<void>>>();
const ending = new Set<number>();

function searchFor(application: Awaited<ReturnType<typeof openApplication>>, id: number) {
  return (query: string, refs: string[], limit: number, mode: SearchMode = "semantic") => application.retrieval.search(query, refs, limit,
    (command) => hostRequests.call(id, command), application.importer.isRunning(), mode);
}
type TriageApplication = { sources: SourceJournal; environment: CoordinatorEnvironment; executions: Executions;
  toolsets: Toolsets; retrieval: Retrieval; importer: CodexImporter };
async function triageSources(application: TriageApplication, id: number, command: Extract<RuntimeCommand, { type: "triage_sources" }>): Promise<void> {
  const { sources, environment, executions, toolsets } = application;
  if (!await sources.hasWork()) return;
  const hosts = await environment.hosts(command.cwd, null, command.hosts);
  const default_host = await environment.defaultHost(hosts);
  const search = (query: string, refs: string[], limit: number, mode: SearchMode = "semantic") => application.retrieval.search(query, refs, limit,
    (operation) => hostRequests.call(id, operation), application.importer.isRunning(), mode);
  await sources.triage({ ...command, hosts }, (conversation, model) => executions.bind(conversation.id.toString(), {
    model, cwd: command.cwd, hosts, default_host, connectedHosts: () => environment.hosts(command.cwd, null, command.hosts),
    role: "triage", search, call: (operation) => hostRequests.call(id, environment.route(operation, default_host)),
    notify: (task_id, text) => emit(id, { type: "notice", task_id, text }),
  }), toolsets.triage);
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
function submitInput(id: number, command: Extract<RuntimeCommand, { type: "submit_input" }>, responseId = id): Promise<void> {
  if (!activeCommands.has(id) || ending.has(id)) {
    emit(responseId, { type: "input_rejected", input_id: command.input_id, message: "The turn ended before admission; retry this input." });
    return Promise.resolve();
  }
  const worker = workers.get(id), main = mainTurns.get(id);
  if (main !== undefined) main.admissions += 1;
  const operations = inputControls.get(id) ?? new Set<Promise<void>>(); inputControls.set(id, operations);
  const operation = (async () => {
    validateInput(command.input, command.attachments);
    if (main !== undefined && !await main.ready) throw new TaskError("The turn could not start; this input was not accepted");
    const stopping = interrupts.get(id); await stopping;
    if (worker !== undefined) {
      if (worker.controller.signal.aborted) throw new TaskError("This worker is detaching");
      await (await app()).tasks.input(worker.command, command.input, command.input_id, command.mode, command.attachments);
    } else {
      if (main === undefined || !main.accepting || main.conversation === undefined) throw new TaskError("The turn has finished; this input was not accepted");
      if (interrupts.get(id) === stopping) {
        interrupts.delete(id); interrupted.delete(id); hostRequests.resumeRequest(id);
      }
      const application = await app();
      const prepared = await application.attachments.input(command.input, command.attachments, application.executions.get(main.conversation.id.toString()).call);
      const conversation = main.conversation;
      const submission = await application.attachments.admit(command.attachments, () => {
        if (!main.accepting || interrupted.has(id) || interrupts.get(id) !== undefined) return undefined;
        return conversation.submit({ type: "input", ...prepared, requestId: command.input_id,
          whenBusy: command.mode === "steer" ? "steer" : "followUp" }, BACKGROUND_CONTEXT);
      });
      if (submission === undefined) throw new TaskError("The turn stopped while attachments were being prepared; this input was not accepted");
      if (!main.accepting) {
        await main.conversation.abort(BACKGROUND_CONTEXT);
        throw new TaskError("The turn ended while this input was being saved; its original is retained");
      }
      main.inputs.push({ input_id: command.input_id, submission });
    }
    if (responseId !== id) emit(id, { type: "input_accepted", input_id: command.input_id });
    emit(responseId, { type: "input_accepted", input_id: command.input_id });
  })().catch((error: unknown) => {
    emit(responseId, { type: "input_rejected", input_id: command.input_id,
      message: error instanceof TaskError ? error.message : "Input could not be saved; its draft is retained" });
  }).finally(() => {
    if (main !== undefined) { main.admissions -= 1; main.wake?.(); }
    operations.delete(operation);
  });
  operations.add(operation);
  return operation;
}
async function handle(request: RuntimeRequest): Promise<void> {
  const { id } = request;
  let effective = request.command;
  const initial = request.command;
  if (initial.type === "chat" || initial.type === "run_task" || initial.type === "attach_main" || initial.type === "attach_conversation") activeCommands.add(id);
  if (initial.type === "chat") mainTurns.set(id, mainTurn());
  if (initial.type === "run_task" && initial.interactive === true) {
    workers.set(id, { command: initial, controller: new AbortController() });
  }
  try {
    if (effective.type === "conversation_input" && effective.conversation_id === ROOT_CONVERSATION_ID.toString()) {
      effective = { type: "main_input", input_id: effective.input_id, input: effective.input, mode: effective.mode,
        ...(effective.context === undefined ? {} : { context: effective.context }), ...(effective.attachments === undefined ? {} : { attachments: effective.attachments }) };
    }
    if (effective.type === "main_input") {
      validateInput(effective.input, effective.attachments);
      const application = await app();
      const root = await application.harness.root(BACKGROUND_CONTEXT);
      const reconciled = await reconcileMainInput(root, effective.input_id);
      if (reconciled !== undefined) { for (const event of reconciled) emit(id, event); return; }
      const owner = [...mainTurns].find(([owner, turn]) => turn.accepting && !ending.has(owner))?.[0];
      if (owner !== undefined) {
        await submitInput(owner, { type: "submit_input", input_id: effective.input_id, input: effective.input, mode: effective.mode, ...(effective.attachments === undefined ? {} : { attachments: effective.attachments }) }, id);
        return;
      }
      const context = effective.context;
      const hosts = await application.environment.hosts(context?.cwd ?? "/", context?.origin_host_id ?? null, context?.hosts ?? []);
      const host = await application.environment.defaultHost(hosts);
      if (host === null) throw new TaskError("The coordinator execution host is offline");
      const admittedOwner = [...mainTurns].find(([owner, turn]) => turn.accepting && !ending.has(owner))?.[0];
      if (admittedOwner !== undefined) {
        await submitInput(admittedOwner, { type: "submit_input", input_id: effective.input_id, input: effective.input, mode: effective.mode, ...(effective.attachments === undefined ? {} : { attachments: effective.attachments }) }, id);
        return;
      }
      effective = { type: "chat", input: effective.input, input_id: effective.input_id, instructions: context?.instructions ?? "", model: null,
        origin_host_id: context?.origin_host_id ?? host.host_id ?? null, cwd: context?.cwd ?? host.cwd, hosts, ...(effective.attachments === undefined ? {} : { attachments: effective.attachments }) };
      activeCommands.add(id); mainTurns.set(id, mainTurn());
    }
    const command = effective;
    switch (command.type) {
      case "attachment": emit(id, { type: "attachment", response: await (await app()).attachments.request(command.request) }); break;
      case "run_background": {
        if (backgroundOwner !== undefined) throw new TaskError("The coordinator already owns background execution");
        backgroundOwner = id;
        backgroundSources = command.settings.sources;
        const stopped = new Promise<void>((resolve) => { stopBackground = resolve; });
        try {
          await (await app()).background.start(command.settings);
          await stopped;
        } finally { backgroundOwner = undefined; stopBackground = undefined; }
        break;
      }
      case "sync_jobs": emit(id, { type: "jobs_synced", report: await (await app()).background.syncJobs(command.jobs) }); break;
      case "job_status": emit(id, { type: "job_status", status: await (await app()).background.status() }); break;
      case "list_jobs": emit(id, { type: "scheduled_jobs", jobs: await (await app()).background.listJobs() }); break;
      case "read_job": emit(id, { type: "scheduled_job", job: await (await app()).background.getJob(command.job_id) }); break;
      case "run_job": emit(id, { type: "job_run", run: await (await app()).background.runJob(command) }); break;
      case "configure_coordinator":
        await (await app()).environment.configure(command.bootstrap); emit(id, { type: "configured" }); break;
      case "register_node":
        await (await app()).environment.register(command.node); emit(id, { type: "node_registered", host_id: command.node.host_id }); break;
      case "set_connected_nodes":
        (await app()).environment.setConnected(command.host_ids); emit(id, { type: "configured" }); break;
      case "environment": emit(id, await (await app()).environment.environment(command.telemetry ? (operation) => hostRequests.call(id, operation) : undefined)); break;
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
      case "usage": {
        if (command.provider !== "openai") {
          emit(id, { type: "usage", usage: { state: "unavailable", reason: "unsupported_provider" } }); break;
        }
        try {
          const status = await auth.status();
          if (status.state === "signed_out") {
            emit(id, { type: "usage", usage: { state: "unavailable", reason: "not_signed_in" } }); break;
          }
          const email = status.account?.email;
          if (email === undefined || email === null || email.trim().length === 0) {
            emit(id, { type: "usage", usage: { state: "unavailable", reason: "identity_unavailable" } }); break;
          }
          const result = await hostRequests.call(id, { type: "read_usage", expected_email: email });
          emit(id, { type: "usage", usage: result.type === "usage" ? result.usage : { state: "unavailable", reason: "read_failed" } });
        } catch { emit(id, { type: "usage", usage: { state: "unavailable", reason: "read_failed" } }); }
        break;
      }
      case "conversation_settings": {
        const application = await app();
        const settings = await conversationSettings(application.tasks, application.environment, command);
        if (command.change !== null) {
          application.executions.setModel(settings.conversation_id, settings.model);
          for (const [request, conversation] of activeConversations) {
            if (conversation.id.toString() === settings.conversation_id && !ending.has(request)) {
              emit(request, { type: "conversation_settings", settings: { ...settings, catalog: [] } });
            }
          }
        }
        emit(id, { type: "conversation_settings", settings }); break;
      }
      case "logout":
        await auth.logout();
        emit(id, { type: "auth_status", status: await auth.status() });
        break;
      case "feedback": {
        const application = await app();
        const root = await application.harness.root(BACKGROUND_CONTEXT);
        const context = { ...command.context, model: command.context.model ?? application.executions.model(root.id.toString()) ??
          await application.environment.model(null) };
        const refs = await application.attachments.resolve(command.context.attachments);
        const bundle = await application.feedback.capture(command.description, { ...context, attachments: refs }, command.input_id);
        await application.attachments.retain(bundle.context.attachments);
        if (command.input_id !== undefined) emit(id, { type: "input_accepted", input_id: command.input_id });
        const receipt = await application.repairs.dispatch(bundle, (operation) => hostRequests.call(id, operation));
        emit(id, { type: "feedback_ready", receipt, ...(command.input_id === undefined ? {} : { input_id: command.input_id }) }); break;
      }
      case "read_feedback": emit(id, { type: "feedback", bundle: await (await app()).feedback.read(command.id) }); break;
      case "import_codex": {
        const application = await app(); const available = await application.environment.environment();
        const selected = command.embedding_host?.normalize("NFKC").trim().toLocaleLowerCase();
        const embeddingHost = selected === undefined ? undefined : available.nodes.find((node) =>
          node.host_id.toLocaleLowerCase() === selected || node.name.normalize("NFKC").trim().toLocaleLowerCase() === selected);
        if (selected !== undefined && embeddingHost === undefined) throw new EnvironmentError("Choose a registered embedding host by name or ID.");
        const call: HostCall = (operation) => hostRequests.call(id, operation);
        const indexCall: HostCall = async (operation) => {
          if (operation.type !== "embed" || embeddingHost === undefined || !application.environment.isConnected(embeddingHost.host_id)) return call(operation);
          const result = await call({ type: "on_node", host_id: embeddingHost.host_id, command: operation });
          // Embedding is pure compute. A failed worker reply can be retried
          // locally; returned vectors still undergo normal index validation.
          return result.type === "failed" ? call(operation) : result;
        };
        await application.importer.run(available.nodes, available.online_host_ids, command.hosts,
          call, (progress) => emit(id, { type: "import_progress", progress }),
          () => application.retrieval.sync(indexCall, true));
        break;
      }
      case "import_status": emit(id, { type: "import_progress", progress: await (await app()).importer.status() }); break;
      case "search_history": {
        const application = await app();
        const result = await application.tasks.find(command.query, [], command.limit, searchFor(application, id), command.mode);
        emit(id, { type: "saved_matches", ...result }); break;
      }
      case "read_conversation": {
        for (const frame of await history(await (await app()).tasks.conversation(command.conversation_id), command.cursor)) emit(id, frame);
        break;
      }
      case "list_conversations": {
        emit(id, { type: "conversations", ...await (await app()).catalog.list(command.query, command.cursor, command.limit) }); break;
      }
      case "attach_conversation": {
        await conversationViews.attach(id, command.conversation_id, (event) => emit(id, event), command.input_ids ?? []); break;
      }
      case "conversation_input": {
        await conversationViews.input(command, (operation) => hostRequests.call(id, operation), (event) => emit(id, event)); break;
      }
      case "conversation_interrupt": {
        const conversation = await (await app()).tasks.conversation(command.conversation_id);
        const owner = [...activeConversations].find(([request, active]) => !ending.has(request) &&
          active.id === conversation.id && (workers.has(request) || mainTurns.has(request)))?.[0];
        if (owner === undefined) await conversation.abort(BACKGROUND_CONTEXT);
        else await interrupt(owner);
        emit(id, { type: "interrupted" }); break;
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
        const host = "binding" in task.worker ? await tasks.workerHost(task.id)
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
      case "read_history":
      case "read_tool_details": {
        const { harness, tasks } = await app();
        const taskId = command.task_id ?? null, agentId = command.agent_id ?? null;
        if (taskId === null && agentId !== null) throw new TaskError("Choose a task for agent history");
        const task = taskId === null ? undefined : await tasks.get(taskId);
        const conversation = task === undefined ? await harness.root(BACKGROUND_CONTEXT)
          : await tasks.conversation(agentId === null ? task.conversation_id
            : task.agents.find((agent) => agent.id === agentId)?.conversation_id ?? "");
        if (command.type === "read_history") for (const frame of await history(conversation, command.cursor)) emit(id, frame);
        else emit(id, { type: "tool_details", details: await toolDetails(conversation, command.entry_id, command.call_id) });
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
        await triageSources(application, id, command);
        emit(id, { type: "sources", sources: await application.sources.states() });
        break;
      }
      case "run_task": {
        const application = await app();
        const { tasks, executions, toolsets, environment } = application;
        let stop: (() => Promise<void>) | undefined;
        try {
        const worker = workers.get(id);
        const configured = async (conversation: Conversation, title: string) => {
          if (interrupted.has(id)) await interrupt(id);
          emit(id, { type: "task_ready", conversation_id: conversation.id.toString(), title });
          const model = executions.model(conversation.id.toString());
          if (model === undefined) throw new TaskError("The worker execution model is unavailable");
          emit(id, { type: "conversation_settings", settings: { conversation_id: conversation.id.toString(),
            task_id: command.task_id, agent_id: command.agent_id ?? null, model, catalog: [] } });
        };
        const answer = await tasks.run(command, (conversation, host, model) => executions.bind(conversation.id.toString(), {
          model, cwd: host.cwd, hosts: [host], default_host: host, origin_host_id: host.host_id ?? null,
          connectedHosts: () => environment.hosts(host.cwd, host.host_id ?? null, [host]),
          role: "worker", search: searchFor(application, id), call: (operation) => hostRequests.call(id, operation),
        }),
        command.agent_id === undefined ? toolsets.worker : toolsets.agent, (operation) => hostRequests.call(id, operation), (selected) => inference.preflight(selected),
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
            await configured(conversation, title);
            for (const frame of await history(conversation, null)) emit(id, frame);
            stop = await activity(tasks.session, conversation, (activity) => emit(id, { type: "activity", activity }),
              (message) => emit(id, { type: "message", message }));
          },
          configured,
          answer(conversation_id, text, entry_id) { emit(id, { type: "answer", conversation_id, text, ...(entry_id === undefined ? {} : { entry_id }) }); },
          idle() { emit(id, { type: "worker_idle" }); },
          rejected(input_id, message) { emit(id, { type: "input_rejected", input_id, message }); },
        });
        if (worker === undefined) emit(id, { type: "answer", ...answer });
        } finally { await stop?.(); }
        break;
      }
      case "main_interrupt": {
        const owner = [...mainTurns].find(([owner]) => !ending.has(owner))?.[0];
        if (owner !== undefined) await interrupt(owner);
        break;
      }
      case "main_feedback": {
        const application = await app();
        const root = await application.harness.root(BACKGROUND_CONTEXT);
        const host = await application.environment.defaultHost(await application.environment.hosts("/", null, []));
        if (host?.host_id === undefined || host.host_id === null) throw new TaskError("The coordinator execution host is offline");
        const refs = await application.attachments.resolve(command.attachments);
        const bundle = await application.feedback.capture(command.description, { attachments: refs, origin_host_id: host.host_id,
          cwd: host.cwd, conversation_id: root.id.toString(), task_id: null, agent_id: null,
          model: application.executions.model(root.id.toString()) ?? await application.environment.model(null),
          binding: null, draft: "", queued_inputs: [], client_errors: [] }, command.input_id);
        await application.attachments.retain(bundle.context.attachments);
        if (command.input_id !== undefined) emit(id, { type: "input_accepted", input_id: command.input_id });
        const receipt = await application.repairs.dispatch(bundle, (operation) => hostRequests.call(id, operation));
        emit(id, { type: "feedback_ready", receipt, ...(command.input_id === undefined ? {} : { input_id: command.input_id }) }); break;
      }
      case "observe_main": {
        const application = await app();
        const root = await application.harness.root(BACKGROUND_CONTEXT);
        let finish = () => {};
        const finished = new Promise<void>((resolve) => { finish = resolve; });
        const observer: MainObserver = { buffer: [], bytes: 0, overflow: false, finish };
        mainObservers.set(id, observer);
        const stopNotices = watchMainNotices(application.harness, root, (event) => queueMainObserver(id, observer, event));
        try {
          emit(id, { type: "main_ready", conversation_id: root.id.toString(),
            model: await inference.legacy(root, await application.environment.model(null)), cwd: "" });
          for (const frame of await history(root, null)) emit(id, frame);
          for (const input_id of command.input_ids) {
            for (const event of await reconcileMainInput(root, input_id) ?? []) emit(id, event);
          }
          if (observer.overflow) { failure(id, "internal", "Observation fell behind during history load. Reconnect to recover saved history."); break; }
          for (const frame of observer.buffer ?? []) emit(id, frame);
          delete observer.buffer;
          if (mainTurns.size === 0) emit(id, { type: "worker_idle" });
          await finished;
        } finally { stopNotices(); mainObservers.delete(id); }
        break;
      }
      case "attach_main": {
        const application = await app();
        const snapshot = async () => {
          const root = await application.harness.root(BACKGROUND_CONTEXT);
          for (const frame of await history(root, null)) emit(id, frame);
        };
        const [owner, turn] = [...mainTurns].find(([owner]) => !ending.has(owner)) ?? [];
        if (owner === undefined || turn === undefined) { await snapshot(); break; }
        let finish = () => {};
        const finished = new Promise<void>((resolve) => { finish = resolve; });
        const view = { owner, live: false, finish }; mainViews.set(id, view);
        try {
          if (!await Promise.race([turn.ready, finished.then(() => false)]) || !mainTurns.has(owner)) { await snapshot(); break; }
          if (turn.info !== undefined) {
            const current = application.executions.model(turn.info.conversation_id);
            emit(id, { ...turn.info, model: current ?? turn.info.model });
            view.live = true;
          }
          await finished;
        } finally { mainViews.delete(id); }
        break;
      }
      case "chat": {
        let submissionAttempted = false;
        const turn = mainQueue.then(async () => {
          if (interrupted.has(id)) { emit(id, { type: "interrupted" }); return; }
          if (command.model !== null) await inference.preflight(command.model);
          const application = await app();
          const { harness, tasks, environment, executions, toolsets } = application;
          const root = await harness.root(BACKGROUND_CONTEXT);
          if (command.model !== null) await inference.configure(root, command.model, {});
          let selected = await inference.legacy(root, await environment.model(null));
          await inference.preflight(selected);
          const hosts = await environment.hosts(command.cwd, command.origin_host_id, command.hosts);
          const default_host = await environment.defaultHost(hosts);
          activeConversations.set(id, root);
          if (interrupted.has(id)) { emit(id, { type: "interrupted" }); return; }
          await root.waitForIdle(BACKGROUND_CONTEXT);
          if (interrupted.has(id)) { await interrupts.get(id); return; }
          const release = executions.bind(root.id.toString(), {
            model: selected, cwd: command.cwd, hosts, default_host, origin_host_id: command.origin_host_id,
            connectedHosts: () => environment.hosts(command.cwd, command.origin_host_id, command.hosts), search: searchFor(application, id),
            project: () => hostRequests.call(id, command.origin_host_id === null
              ? { type: "project_guidance", cwd: command.cwd }
              : { type: "on_node", host_id: command.origin_host_id, command: { type: "project_guidance", cwd: command.cwd } }), call: (operation) => hostRequests.call(id, environment.route(operation, default_host)),
            notify: (task_id, text) => emit(id, { type: "notice", task_id, text }),
          });
          const stop = await activity(harness, root, (activity) => emit(id, { type: "activity", activity }),
            (message) => emit(id, { type: "message", message }), (text) => emit(id, { type: "text_delta", text }));
          const turn = mainTurns.get(id);
          try {
            const related = await tasks.find(command.input, [], 8,
              (query, refs, limit) => application.retrieval.snapshot(query, refs, limit));
            if (interrupted.has(id)) { await interrupts.get(id); return; }
            const relatedContext = related.matches.length === 0 && related.gaps.length === 0 ? "" : "\n\nRelated saved conversations and retrieval coverage (read and reuse matching work):\n" +
              JSON.stringify(related);
            selected = await inference.configureCurrent(root, selected, {
              instructions: (await environment.instructions(command.instructions)) + relatedContext, cwd: command.cwd, extensions: toolsets.main });
            executions.setModel(root.id.toString(), selected);
            if (interrupted.has(id)) { await interrupts.get(id); return; }
            const prepared = await application.attachments.input(command.input, command.attachments, executions.get(root.id.toString()).call);
            const submission = await application.attachments.admit(command.attachments, () => {
              if (interrupted.has(id)) return undefined;
              submissionAttempted = true;
              return root.submit({ type: "input", ...prepared,
                ...(command.input_id === undefined ? {} : { requestId: command.input_id }) }, BACKGROUND_CONTEXT);
            });
            if (submission === undefined) { await interrupts.get(id); return; }
            if (command.input_id !== undefined) emit(id, { type: "input_accepted", input_id: command.input_id });
            if (turn === undefined) throw new TaskError("The main execution owner is unavailable");
            turn.conversation = root; turn.info = { type: "main_ready", conversation_id: root.id.toString(), model: selected, cwd: command.cwd };
            turn.inputs.push({ submission, ...(command.input_id === undefined ? {} : { input_id: command.input_id }) }); turn.start(true);
            const answers = new Set<string>(); let next = 0;
            for (;;) {
              const input = turn.inputs[next];
              if (input === undefined) {
                if (turn.admissions === 0) { turn.accepting = false; break; }
                const active = turn;
                await new Promise<void>((resolve) => { active.wake = resolve; }); delete turn.wake; continue;
              }
              next += 1;
              const settled = await input.submission.wait(BACKGROUND_CONTEXT);
              if (settled.type === "input" && settled.status === "unanswered" && settled.reason === "aborted") {
                if (input.input_id !== undefined) for (const event of await reconcileMainInput(root, input.input_id) ?? []) emit(id, event);
                continue;
              }
              if (settled.type !== "input" || settled.status !== "done") throw new TaskError(await modelFailureMessage(root, "The model turn did not complete; its state is retained"));
              if (answers.has(settled.answer.toString())) continue;
              answers.add(settled.answer.toString());
              const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
              const text = entry?.model?.flatMap((message) => message.role !== "assistant" ? []
                : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n") ?? "";
              emit(id, { type: "answer", conversation_id: root.id.toString(), text, ...(entry === undefined ? {} : { entry_id: entry.id.toString() }) });
            }
          } catch (error) {
            if (turn !== undefined) {
              turn.accepting = false; await root.abort(BACKGROUND_CONTEXT);
              for (const input of turn.inputs) if (input.input_id !== undefined && (await input.submission.status(BACKGROUND_CONTEXT)).status === "unanswered") {
                for (const event of await reconcileMainInput(root, input.input_id) ?? []) emit(id, event);
              }
            }
            throw error;
          } finally {
            if (turn !== undefined) { turn.accepting = false; turn.start(false); }
            await Promise.allSettled([...(inputControls.get(id) ?? [])]);
            await stop(); release();
          }
        });
        mainQueue = turn.then(() => {}, () => {});
        try { await turn; }
        finally {
          // Preflight/attachment failures cannot have submitted this input.
          // Once native submission starts, preserve uncertain outcomes instead
          // of restoring a draft that may already be committed.
          if (!submissionAttempted && command.input_id !== undefined) emit(id, { type: "input_rejected",
            input_id: command.input_id, message: "Input was not submitted; its draft is restored." });
        }
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
    else if (error instanceof TaskError || error instanceof ModelError || error instanceof EnvironmentError || error instanceof AttachmentError) failure(id, "invalid_request", error.message);
    else emit(id, errorEvent(error));
  } finally {
    ending.add(id);
    const turn = mainTurns.get(id); if (turn !== undefined) { turn.accepting = false; turn.start(false); }
    await Promise.allSettled([...(inputControls.get(id) ?? [])]); inputControls.delete(id);
    await interrupts.get(id)?.catch(() => {});
    activeCommands.delete(id); activeConversations.delete(id); interrupted.delete(id); interrupts.delete(id);
    workers.delete(id);
    hostRequests.finish(id);
    emit(id, { type: "done" });
    mainTurns.delete(id);
    ending.delete(id);
  }
}

const pending = new Set<Promise<void>>();
try {
  for await (const line of protocolLines(process.stdin)) {
    let request: unknown;
    try { request = JSON.parse(line); } catch {
      failure(0, "invalid_request", "Invalid protocol frame"); emit(0, { type: "done" }); continue;
    }
    if (!validRequest(request)) {
      const reply = invalidHostReply(request, VERSION);
      if (reply !== undefined) {
        hostRequests.reply(reply.id, reply.command.call_id, reply.command.result);
        continue;
      }
      failure(0, "invalid_request", "Invalid protocol frame"); emit(0, { type: "done" }); continue;
    }
    if (request.version !== VERSION) {
      failure(request.id, "invalid_request", "Unsupported protocol version"); emit(request.id, { type: "done" }); continue;
    }
    if (request.command.type === "detach_main") {
      mainViews.get(request.id)?.finish();
      mainObservers.get(request.id)?.finish();
      continue;
    }
    if (request.command.type === "detach_conversation") { conversationViews.detach(request.id); continue; }
    if (request.command.type === "interrupt") {
      // Done may already be buffered while Rust still owns the request and sends its last control.
      if (!activeCommands.has(request.id)) continue;
      void interrupt(mainViews.get(request.id)?.owner ?? request.id).catch(() => {
        if (activeCommands.has(request.id)) failure(request.id, "internal", "Interruption could not be confirmed; inspect current work");
      });
      continue;
    }
    if (request.command.type === "submit_input") { submitInput(mainViews.get(request.id)?.owner ?? request.id, request.command); continue; }
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
          await (await app()).tasks.input(worker.command, input, input_id, undefined, request.command.attachments);
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
  stopBackground?.();
  conversationViews.close();
  for (const worker of workers.values()) worker.controller.abort();
  await Promise.allSettled(pending);
} finally {
  if (application !== undefined) {
    const opened = await application.catch(() => undefined);
    if (opened !== undefined) { opened.stopPlacements(); opened.retrieval.close(); await opened.harness.close(BACKGROUND_CONTEXT); }
  }
}
