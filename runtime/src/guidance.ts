import { defineExtension, hook, section, ToolTask, type Extension } from "@earendil-works/pi-durable";
import type { HostResult } from "./generated/HostResult.js";
import type { Execution, Executions } from "./tools.js";

type Freshness = { fresh: true } | { fresh: false; message: string };

function readFailure(result: HostResult, scope: string): Error {
  return new Error(result.type === "failed" ? result.message : `${scope} guidance was not returned by its owning host`);
}

/** File guidance is rendered anew by Pi before every generation request. */
export function createGuidance(executions: Executions): Extension {
  // Binding identity prevents a replacement execution from inheriting freshness.
  // Weak ownership also releases status when the execution client is detached.
  const freshness = new WeakMap<Execution, Map<string, Freshness>>();
  function record(execution: Execution, conversation: string, status: Freshness): void {
    let states = freshness.get(execution);
    if (states === undefined) { states = new Map(); freshness.set(execution, states); }
    states.set(conversation, status);
  }
  return defineExtension({
    name: "workspace_guidance",
    sections: [section("workspace_guidance", async ({ conversationId }) => {
      const id = conversationId.toString();
      let execution: Execution | undefined;
      try {
        execution = executions.get(id);
        const shared = await execution.call({ type: "reload_guidance" });
        if (shared.type !== "shared_guidance") throw readFailure(shared, "Shared");
        const project = await (execution.project?.() ?? execution.call({ type: "project_guidance", cwd: execution.cwd }));
        if (project.type !== "project_guidance") throw readFailure(project, "Project");
        const parts: string[] = [];
        if (shared.global.text.trim()) parts.push(`# Global instructions\n\n${shared.global.text}`);
        for (const repository of shared.context_repositories) {
          parts.push(`# Context repository ${repository.id}: ${repository.root}\n\n${repository.instructions}`);
        }
        const coveredSources = new Set([...shared.global.sources, ...shared.context_sources].map((source) => source.sha256));
        const projectAlreadyIncluded = project.snapshot.sources.length > 0
          && project.snapshot.sources.every((source) => coveredSources.has(source.sha256));
        if (project.snapshot.text.trim() && !projectAlreadyIncluded) parts.push(project.snapshot.text);
        if (shared.workflow_policy.trim()) parts.push(`# Agent workflow\n\n${shared.workflow_policy}`);
        record(execution, id, { fresh: true });
        return parts.join("\n\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : "The current guidance files could not be read";
        if (execution !== undefined) record(execution, id, { fresh: false, message });
        // Pi deliberately retains a section when render throws. Return an
        // explicit replacement so stale instructions cannot remain in effect.
        return `Workspace guidance is unavailable: ${message}\nReport the read failure and restore source access before taking actions.`;
      }
    })],
    hooks: [hook(ToolTask, {
      beforeTool(_call, api) {
        try {
          const id = api.conversationId.toString();
          const execution = executions.get(id);
          const status = freshness.get(execution)?.get(id);
          if (status?.fresh) return undefined;
          return { block: status === undefined ? "Workspace guidance has not been refreshed for this execution" : `Workspace guidance is unavailable: ${status.message}` };
        } catch {
          return { block: "The execution client disconnected before workspace guidance could be refreshed" };
        }
      },
    })],
  });
}
