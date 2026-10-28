import { defineEntry } from "@earendil-works/pi-durable";
import type { AllocationDecision } from "./generated/AllocationDecision.js";
import type { AllocationResult } from "./generated/AllocationResult.js";
import type { HostResult } from "./generated/HostResult.js";

/** Private lifecycle evidence; no model projection and no second logging store. */
export const AllocationDecisionEntry = defineEntry<AllocationDecision>("agent.allocation");

export function allocationResult(result: HostResult): AllocationResult {
  switch (result.type) {
    case "written": return { type: "written" };
    case "spawned": return { type: "spawned", binding: result.binding };
    case "worker_presence": return { type: "presence", presence: result.presence };
    case "creation_uncertain": return { type: "creation_uncertain", session_id: result.session_id };
    case "failed": return { type: "failed", message: result.message };
    default: return { type: "failed", message: `Unexpected native allocation result: ${result.type}` };
  }
}
