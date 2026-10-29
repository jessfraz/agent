import type { Extension } from "@earendil-works/pi-durable";
import type { createBrowserTools } from "./browser.js";
import type { createGuidance } from "./guidance.js";
import type { createResourceTools } from "./resources.js";
import type { createSourceTools } from "./sources.js";
import type { createAppTools, createJobTools } from "./tools.js";

export type ToolRole = "main" | "triage" | "worker" | "agent";
export type Toolsets = Record<ToolRole, readonly Extension[]>;

/** Compose existing tools by actor ownership; execution guards remain on the tools. */
export function createToolsets({ guidance, tools, sourceTools, resourceTools, browserTools, jobTools }: {
  guidance: ReturnType<typeof createGuidance>;
  tools: ReturnType<typeof createAppTools>;
  sourceTools: ReturnType<typeof createSourceTools>;
  resourceTools: ReturnType<typeof createResourceTools>;
  browserTools: ReturnType<typeof createBrowserTools>;
  jobTools: ReturnType<typeof createJobTools>;
}): Toolsets {
  return {
    main: [guidance, tools.host, tools.main, sourceTools.main, resourceTools.main, browserTools, jobTools],
    triage: [guidance, tools.host, tools.main, sourceTools.main, browserTools, jobTools],
    worker: [guidance, tools.host, tools.worker, sourceTools.worker, resourceTools.worker, browserTools],
    agent: [guidance, tools.host, tools.agent, sourceTools.worker, resourceTools.worker, browserTools],
  };
}
