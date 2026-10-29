import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { DEFAULT_MODEL } from "./models.js";
import type { AgentNode } from "./generated/AgentNode.js";
import type { CoordinatorBootstrap } from "./generated/CoordinatorBootstrap.js";
import type { CoordinatorSettings } from "./generated/CoordinatorSettings.js";
import type { HostCommand } from "./generated/HostCommand.js";
import type { ModelSelection } from "./generated/ModelSelection.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { WorkerHost } from "./generated/WorkerHost.js";
import type { HostCall } from "./tasks.js";

type Registry = { settings: CoordinatorSettings | null; coordinator_host_id: string | null;
  nodes: { node: AgentNode; seen_at: number; telemetry?: boolean }[] };
const State = defineDoc<Registry>({ kind: "agent.environment", scope: "session", version: 1,
  initial: () => ({ settings: null, coordinator_host_id: null, nodes: [] }), checkpointWhen: () => true });
const DEFAULT_SETTINGS: CoordinatorSettings = { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] };
export class EnvironmentError extends Error {}
function name(value: string): string { return value.normalize("NFKC").trim().toLocaleLowerCase(); }
function validateNode(node: AgentNode): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.host_id) ||
      name(node.name).length === 0 || !node.home_directory.startsWith("/") || !node.agent_program.startsWith("/")) {
    throw new EnvironmentError("Worker registration needs its native Rex ID, name and absolute local paths.");
  }
}
function upsert(registry: Registry, node: AgentNode): void {
  validateNode(node);
  if (registry.nodes.some((saved) => saved.node.host_id !== node.host_id && name(saved.node.name) === name(node.name))) {
    throw new EnvironmentError("Worker names must identify one native Rex host.");
  }
  const saved = registry.nodes.find((saved) => saved.node.host_id === node.host_id);
  const telemetry = node.machine !== undefined && node.machine !== null;
  if (saved === undefined) registry.nodes.push({ node, seen_at: Date.now(), telemetry });
  else {
    const { machine: incoming, ...metadata } = node;
    const previous = saved.node.machine;
    const machine = previous !== undefined && previous !== null &&
      (incoming === undefined || incoming === null || previous.observed_at_ms > incoming.observed_at_ms) ? previous : incoming;
    saved.node = { ...metadata, ...(machine === undefined || machine === null ? {} : { machine }) };
    saved.telemetry = telemetry;
    saved.seen_at = Date.now();
  }
}

/** Persist metadata; only the owning Rust broker declares a connection online. */
export class CoordinatorEnvironment {
  private connected = new Set<string>();
  private liveGuidance = false;
  constructor(readonly session: Harness) {}
  useLiveGuidance(): void { this.liveGuidance = true; }
  async configure(bootstrap: CoordinatorBootstrap): Promise<void> {
    await this.session.commit(async (tx) => {
      const registry = await tx.doc(State);
      registry.settings = bootstrap.settings;
      if (bootstrap.node !== null) {
        upsert(registry, bootstrap.node); registry.coordinator_host_id = bootstrap.node.host_id;
      }
    }, BACKGROUND_CONTEXT);
  }
  async register(node: AgentNode): Promise<void> {
    await this.session.commit(async (tx) => upsert(await tx.doc(State), node), BACKGROUND_CONTEXT);
  }
  setConnected(hostIds: readonly string[]): void { this.connected = new Set(hostIds); }
  async environment(call?: HostCall): Promise<Extract<RuntimeEventKind, { type: "environment" }>> {
    const unavailable: string[] = [];
    if (call !== undefined) {
      const current = await this.session.snapshot(State, BACKGROUND_CONTEXT);
      const observed = await Promise.all((current?.nodes ?? []).filter(({ node }) => this.connected.has(node.host_id)).map(async ({ node, telemetry }) => {
        // A retained sample can outlive its producer. Only the current
        // registration advertises support for this newer read-only command.
        if (telemetry !== true) { unavailable.push(node.host_id); return undefined; }
        try {
          const result = await call({ type: "on_node", host_id: node.host_id, command: { type: "machine_snapshot" } });
          if (result.type === "machine_snapshot") return { host_id: node.host_id, snapshot: result.snapshot };
        } catch { /* Preserve the last sample when a live read fails. */ }
        unavailable.push(node.host_id); return undefined;
      }));
      if (observed.some((value) => value !== undefined)) await this.session.commit(async (tx) => {
        const registry = await tx.doc(State);
        for (const value of observed) {
          if (value === undefined) continue;
          const node = registry.nodes.find(({ node }) => node.host_id === value.host_id)?.node;
          if (node !== undefined && (node.machine === undefined || node.machine === null || node.machine.observed_at_ms <= value.snapshot.observed_at_ms)) node.machine = value.snapshot;
        }
      }, BACKGROUND_CONTEXT);
    }
    const registry = await this.session.snapshot(State, BACKGROUND_CONTEXT);
    return { type: "environment", settings: registry?.settings ?? DEFAULT_SETTINGS,
      nodes: registry?.nodes.map((saved) => saved.node) ?? [], online_host_ids: [...this.connected],
      ...(unavailable.length === 0 ? {} : { unavailable_host_ids: unavailable.sort() }) };
  }
  async model(override: ModelSelection | null): Promise<ModelSelection> {
    return override ?? (await this.environment()).settings.model;
  }
  async instructions(project: string): Promise<string> {
    if (this.liveGuidance) return "";
    const settings = (await this.session.snapshot(State, BACKGROUND_CONTEXT))?.settings;
    if (settings === null || settings === undefined) return project;
    return [settings.instructions, ...settings.context_repositories.map((repository) =>
      `Context repository ${repository.id}: ${repository.root}. Resolve its relative paths there; use read_context or search_context.\n${repository.instructions}`),
    project].filter((part) => part.trim().length > 0).join("\n\n");
  }
  async context(id: string): Promise<void> {
    if (!(await this.environment()).settings.context_repositories.some((repository) => repository.id === id)) {
      throw new EnvironmentError("Unknown coordinator context repository.");
    }
  }
  private host(node: AgentNode, cwd: string, model?: ModelSelection | null): WorkerHost {
    return { host_id: node.host_id, name: node.name, rex_server: node.rex_server, coordinator: node.coordinator,
      agent_program: node.agent_program, cwd, launch: { ...node.launch, model: model ?? node.launch.model } };
  }
  async hosts(cwd: string, origin: string | null, fallback: readonly WorkerHost[]): Promise<WorkerHost[]> {
    const registry = await this.session.snapshot(State, BACKGROUND_CONTEXT);
    if (registry?.settings === null || registry?.settings === undefined) return [...fallback];
    const preferred = registry.coordinator_host_id;
    return registry.nodes.filter((saved) => this.connected.has(saved.node.host_id))
      .sort((left, right) => Number(right.node.host_id === preferred) - Number(left.node.host_id === preferred) || left.node.name.localeCompare(right.node.name))
      .map(({ node }) => this.host(node, node.host_id === origin ? cwd : node.home_directory));
  }
  async defaultHost(hosts: readonly WorkerHost[]): Promise<WorkerHost | null> {
    const registry = await this.session.snapshot(State, BACKGROUND_CONTEXT);
    if (registry?.settings === null || registry?.settings === undefined) return hosts[0] ?? null;
    return hosts.find((host) => host.host_id === registry.coordinator_host_id) ?? null;
  }
  async deployment(host: WorkerHost, bindingHostId?: string, model?: ModelSelection | null): Promise<WorkerHost> {
    const registry = await this.session.snapshot(State, BACKGROUND_CONTEXT);
    if (registry?.settings === null || registry?.settings === undefined) return host;
    const id = host.host_id ?? bindingHostId;
    const node = registry.nodes.find((saved) => saved.node.host_id === id)?.node;
    if (node === undefined) throw new EnvironmentError("This task's native execution host is not registered.");
    if (!this.connected.has(node.host_id)) throw new EnvironmentError(`Worker ${node.name} is offline; its task was retained.`);
    return this.host(node, host.cwd, model);
  }
  route(command: HostCommand, node: WorkerHost | null): HostCommand {
    if (!["exec", "read_file", "write_file", "edit_file", "attachment_write"].includes(command.type)) return command;
    if (node === null) throw new EnvironmentError("The coordinator execution host is offline; choose a connected host explicitly.");
    return node.host_id === null || node.host_id === undefined ? command : { type: "on_node", host_id: node.host_id, command };
  }
}
