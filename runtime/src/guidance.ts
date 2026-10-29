import type { Context } from "@earendil-works/chord/context";
import { defineExtension, GenerationTask, hook, section, ToolTask, type Extension } from "@earendil-works/pi-durable";
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
  async function render(id: string, context: Context, missingOnly = false): Promise<string | undefined> {
    let execution: Execution | undefined;
    try {
      execution = await executions.ready(id, context);
      if (missingOnly && freshness.get(execution)?.has(id)) return undefined;
      const shared = await execution.call({ type: "reload_guidance" });
      if (shared.type !== "shared_guidance") throw readFailure(shared, "Shared");
      const project = await (execution.project?.() ?? execution.call({ type: "project_guidance", cwd: execution.cwd }));
      if (project.type !== "project_guidance") throw readFailure(project, "Project");
      const parts: string[] = [];
      const hosts = await executions.hosts(id);
      parts.push("Connected worker hosts: " + JSON.stringify({
        default_host_id: execution.default_host?.host_id ?? null, origin_host_id: execution.origin_host_id ?? null,
        project_cwd: execution.cwd, hosts: hosts.map((host) => ({ host_id: host.host_id, name: host.name, cwd: host.cwd })),
      }));
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
      if (context.abortSignal?.aborted) throw error;
      const message = error instanceof Error ? error.message : "The current guidance files could not be read";
      if (execution !== undefined) record(execution, id, { fresh: false, message });
      // Pi deliberately retains a section when render throws. Return an
      // explicit replacement so stale instructions cannot remain in effect.
      return `Workspace guidance is unavailable: ${message}\nReport the read failure and restore source access before taking actions.`;
    }
  }
  return defineExtension({
    name: "workspace_guidance",
    sections: [section("workspace_guidance", ({ conversationId }, context) => render(conversationId.toString(), context))],
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        // Pi can recover at its request checkpoint, after section preparation.
        // Refresh that replacement client's guidance before resending inference.
        const text = await render(api.conversationId.toString(), context, true);
        if (text === undefined) return undefined;
        return { messages: [...request.messages, { role: "system", content: "",
          sections: { workspace_guidance: `<workspace_guidance>\n${text}\n</workspace_guidance>` }, timestamp: Date.now() }] };
      },
    }), hook(ToolTask, {
      async beforeTool(_call, api, context) {
        try {
          const id = api.conversationId.toString();
          const execution = await executions.ready(id, context);
          const status = freshness.get(execution)?.get(id);
          if (status?.fresh) return undefined;
          // A recovered tool may resume before a new model round. Its old
          // instructions cannot authorize an effect under a replacement client.
          return { block: status === undefined
            ? "Workspace guidance has not been refreshed for this execution; reconsider the tool after loading current instructions"
            : `Workspace guidance is unavailable: ${status.message}` };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { block: "The execution client disconnected before workspace guidance could be refreshed" };
        }
      },
    })],
  });
}
