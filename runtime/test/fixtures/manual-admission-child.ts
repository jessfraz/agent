import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { exampleJob, pump } from "./background-runtime.js";
import { openManual } from "./manual-runtime.js";

const directory = process.argv[2], mode = process.argv[3];
if (directory === undefined || (mode !== "api" && mode !== "tool")) throw new Error("Missing manual fixture parameters");
process.stdin.resume();
const app = await openManual(directory, mode === "api");
await app.scheduler.syncJobs([exampleJob()]);
if (mode === "api") {
  const receipt = await app.scheduler.runJob({ type: "run_job", job_id: "example-review", schedule_id: null, request_id: "crash-request" });
  process.stdout.write(receipt.task_id + "\n");
  await new Promise<void>(() => {});
} else {
  const runTool = app.jobTools.tools?.find((tool) => tool.name === "run_job");
  if (runTool === undefined) throw new Error("Manual fixture job tool missing");
  const held = defineExtension({ name: "hold_manual_receipt", wraps: [wrapTool(runTool, (tool) => ({ ...tool,
    async execute(args, api, context) {
      const result = await tool.execute(args, api, context);
      await pump(async () => (await app.receipts())?.jobs.length === 1);
      const task = (await app.tasks.list())[0];
      if (task === undefined) throw new Error("Manual fixture task missing");
      process.stdout.write(task.id + "\n");
      await new Promise<void>(() => {});
      return result;
    },
  }))] });
  app.registry.install(held);
  await app.tasks.inference.configure(app.root, { provider: "openai", model_id: "fixture", reasoning: null, fast: false }, { extensions: [app.jobTools, held] });
  app.faux.setResponses([fauxAssistantMessage(fauxToolCall("run_job", { job_id: "example-review" }), { stopReason: "toolUse" })]);
  await (await app.root.submit({ type: "input", content: "Run the example review now.", requestId: "manual-tool-input" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
}
