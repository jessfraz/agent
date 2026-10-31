import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, ROOT_CONVERSATION_ID, type Extension, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { CleanupPlan } from "./generated/CleanupPlan.js";
import type { CleanupReceipt } from "./generated/CleanupReceipt.js";
import type { ResourceRecord } from "./generated/ResourceRecord.js";
import type { ResourceReport } from "./generated/ResourceReport.js";
import type { WorktreeAllocation } from "./generated/WorktreeAllocation.js";
import type { HostCommand } from "./generated/HostCommand.js";
import { TaskError, TaskStore, type HostCall } from "./tasks.js";
import { Executions } from "./tools.js";

type OwnedResource = { record: ResourceRecord; plan: CleanupPlan | null; receipt: CleanupReceipt | null };
const Resources = defineDoc<{ resources: OwnedResource[] }>({
  kind: "agent.resources", scope: "session", version: 1,
  initial: () => ({ resources: [] }), checkpointWhen: () => true,
});

/** Pi owns the intent and consumers; the host verifies the actual Git identity. */
export class ResourceStore {
  private readonly collecting = new Set<string>();
  constructor(private readonly session: Harness, private readonly tasks: TaskStore) {}
  async list(): Promise<ResourceRecord[]> {
    return (await this.session.snapshot(Resources, BACKGROUND_CONTEXT))?.resources.map((item) => item.record) ?? [];
  }
  private async entry(tx: Tx, id: string): Promise<OwnedResource> {
    const item = (await tx.doc(Resources)).resources.find((item) => item.record.id === id);
    if (item === undefined) throw new TaskError("Unknown resource");
    return item;
  }
  private async owned(id: string): Promise<OwnedResource> {
    const state = await this.session.snapshot(Resources, BACKGROUND_CONTEXT);
    const item = state?.resources.find((item) => item.record.id === id);
    if (item === undefined) throw new TaskError("Unknown resource");
    return item;
  }
  async attach(taskId: string): Promise<void> {
    await this.session.commit(async (tx) => {
      const resources = await tx.doc(Resources);
      const owned = resources.resources.filter((item) => item.record.task_id === taskId);
      if (owned.some((item) => item.record.state.state === "retiring" || item.record.state.state === "partial")) {
        throw new TaskError("A task worktree is retiring or needs cleanup reconciliation; do not attach to it");
      }
      for (const item of owned) {
        if (item.record.state.state !== "removed" && !item.record.consumers.includes(taskId)) item.record.consumers.push(taskId);
      }
    }, BACKGROUND_CONTEXT);
  }
  async allocate(request: WorktreeAllocation, call: HostCall): Promise<ResourceRecord> {
    await this.tasks.get(request.task_id);
    const created = await this.session.commit(async (tx) => {
      const resources = await tx.doc(Resources);
      const previous = resources.resources.find((item) => item.record.id === request.allocation_id);
      if (previous !== undefined) {
        if (previous.record.task_id !== request.task_id || previous.record.host_id !== request.host_id ||
            previous.record.repository !== request.repository || previous.record.branch !== request.branch) {
          throw new TaskError("A resource allocation ID cannot be reused for another request");
        }
        return false;
      }
      resources.resources.push({ record: { id: request.allocation_id, host_id: request.host_id, task_id: request.task_id,
        repository: request.repository, branch: request.branch, consumers: [request.task_id], state: { state: "allocating" } },
        plan: null, receipt: null });
      return true;
    }, BACKGROUND_CONTEXT);
    if (created) {
      try {
        const result = await call({ type: "resource_allocate", request });
        if (result.type !== "resource") throw new TaskError("Worktree allocation was not confirmed; inspect the recorded allocation before retrying");
        await this.adopt(result.report);
      } catch {
        await this.session.commit(async (tx) => {
          const item = await this.entry(tx, request.allocation_id);
          if (item.record.state.state === "allocating") item.record.state = {
            state: "held", identity: null, reason: "Allocation outcome is uncertain; inspect this allocation instead of creating another worktree",
          };
        }, BACKGROUND_CONTEXT);
      }
    }
    return (await this.owned(request.allocation_id)).record;
  }
  private async adopt(report: ResourceReport): Promise<void> {
    await this.session.commit(async (tx) => {
      const item = await this.entry(tx, report.record.id);
      const before = item.record;
      if (before.task_id !== report.record.task_id || before.host_id !== report.record.host_id ||
          before.repository !== report.record.repository || before.branch !== report.record.branch) {
        throw new TaskError("The host returned a different resource identity");
      }
      if (report.type === "planned") {
        if (before.consumers.length > 0 || !await this.tasks.canReleaseIn(tx, before.task_id)) {
          throw new TaskError("The resource acquired a consumer while cleanup was planned");
        }
        if (report.plan.resource_id !== before.id || report.record.state.state !== "retiring" ||
            report.record.state.plan_id !== report.plan.id) throw new TaskError("The cleanup plan does not own this resource");
        item.plan = report.plan;
      }
      item.record = { ...report.record, consumers: before.consumers };
      if (report.type === "collected") item.receipt = report.receipt;
    }, BACKGROUND_CONTEXT);
  }
  async collect(hostId: string, call: HostCall): Promise<ResourceRecord[]> {
    for (const initial of await this.list()) {
      if (initial.host_id !== hostId || this.collecting.has(initial.id) || initial.state.state === "removed" || initial.state.state === "partial") continue;
      this.collecting.add(initial.id);
      try {
        await this.session.commit(async (tx) => {
          const item = await this.entry(tx, initial.id);
          if (await this.tasks.canReleaseIn(tx, item.record.task_id)) {
            item.record.consumers = item.record.consumers.filter((consumer) => consumer !== item.record.task_id);
          }
        }, BACKGROUND_CONTEXT);
        const current = await this.owned(initial.id);
        if (current.record.consumers.length > 0) continue;
        // A persisted retiring plan is replayable only through the backend's exact identity checks.
        if (current.record.state.state === "retiring" && current.plan !== null) {
          await this.adopt(await this.report({ type: "resource_collect", record: current.record, plan: current.plan }, call));
          continue;
        }
        const inspected = await this.report({ type: "resource_inspect", record: current.record }, call);
        await this.adopt(inspected);
        if (inspected.record.state.state !== "ready") continue;
        const planned = await this.report({ type: "resource_plan_cleanup", record: inspected.record }, call);
        await this.adopt(planned);
        if (planned.type !== "planned") continue;
        await this.adopt(await this.report({ type: "resource_collect", record: planned.record, plan: planned.plan }, call));
      } finally { this.collecting.delete(initial.id); }
    }
    return this.list();
  }
  private async report(command: HostCommand, call: HostCall): Promise<ResourceReport> {
    const result = await call(command);
    if (result.type !== "resource") throw new TaskError(`${command.type} was not confirmed: ${result.type === "failed" ? result.message : `unexpected ${result.type} result`}. Resource state is retained.`);
    return result.report;
  }
}

export function createResourceTools(resources: ResourceStore, tasks: TaskStore, executions: Executions): { main: Extension; worker: Extension } {
  const allocate = defineTool({ name: "allocate_worktree", description: "Create an owned linked worktree for this task. Allocation and cleanup ownership are recorded durably.",
    parameters: Type.Object({ repository: Type.String({ minLength: 1 }), branch: Type.String({ minLength: 1 }) }),
    async execute(args, api, context) {
      const execution = executions.get(api.conversationId.toString());
      const owner = await tasks.owner(api.conversationId.toString());
      const worker = owner.agent?.worker ?? owner.task.worker;
      if (worker.state !== "bound") throw new TaskError("Worktree allocation requires a bound task host");
      const allocation_id = await api.memo("worktree_allocation_id", randomUUID(), context);
      const record = await resources.allocate({ ...args, allocation_id, task_id: owner.task.id, host_id: worker.binding.host_id }, execution.call);
      return { output: [{ type: "text", text: JSON.stringify(record) }], isError: record.state.state !== "ready" };
    } });
  const read = defineTool({ name: "read_resources", description: "Read the owned worktree inventory and cleanup state.", replay: "safe", parameters: Type.Object({}),
    async execute(_args, api) {
      executions.get(api.conversationId.toString());
      const all = await resources.list();
      const owner = api.conversationId === ROOT_CONVERSATION_ID ? undefined : await tasks.owner(api.conversationId.toString());
      const visible = owner === undefined ? all : all.filter((resource) => resource.task_id === owner.task.id);
      return { output: [{ type: "text", text: JSON.stringify(visible) }] };
    } });
  const collect = defineTool({ name: "collect_worktrees", description: "Run the background collector for eligible Beep Boop-owned worktrees on their recorded hosts. Active, dirty, unmerged or uncertain work is retained. Returns inventory and any collection gaps.",
    replay: "safe", parameters: Type.Object({}), async execute(_args, api) {
      const execution = executions.get(api.conversationId.toString());
      const hosts = [...new Set((await resources.list()).filter((resource) => resource.state.state !== "removed" && resource.state.state !== "partial").map((resource) => resource.host_id))];
      const results = await Promise.allSettled(hosts.map((host_id) => resources.collect(host_id,
        (command) => execution.call({ type: "on_node", host_id, command }))));
      const gaps = results.flatMap((result, index) => result.status === "fulfilled" ? []
        : [`${hosts[index]}: ${result.reason instanceof Error ? result.reason.message : "Collection was not confirmed"}`]);
      const inventory = JSON.stringify(await resources.list());
      return { output: [{ type: "text", text: gaps.length === 0 ? inventory : `${inventory}\n\nCollection gaps:\n${gaps.join("\n")}` }], isError: gaps.length > 0 };
    } });
  return {
    main: defineExtension({ name: "resource-inventory", tools: [read, collect] }),
    worker: defineExtension({ name: "app-resources", tools: [allocate, read] }),
  };
}
