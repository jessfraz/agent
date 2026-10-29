import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { runScheduled } from "../../src/scheduled.js";
import { pump } from "./background-runtime.js";
import { openScheduled, scheduledOccurrence } from "./scheduled-runtime.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing scheduled fixture directory");
process.stdin.resume();
const app = await openScheduled(directory);
app.faux.setResponses([async (context) => {
  if (!getCurrentSystemPrompt(context.messages).includes("FRESH_PROJECT_POLICY")) throw new Error("The worker ran without its current project guidance");
  await pump(async () => (await app.tasks.list())[0]?.pending.length === 0);
  process.stdout.write("PLACED\n");
  return new Promise(() => {});
}]);
const scheduled = runScheduled(scheduledOccurrence, new AbortController().signal, app);
await pump(async () => (await app.tasks.list())[0]?.worker.state === "bound");
const task = (await app.tasks.list())[0];
if (task === undefined) throw new Error("The fixture task was not created");
await Promise.all([scheduled, app.worker(task.id)]);
