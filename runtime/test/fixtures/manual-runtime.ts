import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BackgroundScheduler } from "../../src/background.js";
import { createJobTools } from "../../src/tools.js";
import { planned, Receipts } from "./background-runtime.js";
import { openScheduled } from "./scheduled-runtime.js";
import { fixtureModel } from "../model.js";

export async function openManual(directory: string, holdWork = false) {
  const app = await openScheduled(directory);
  let calls = 0;
  const scheduler = new BackgroundScheduler(app.session, app.registry, app.tasks, {
    plan: async (cadence, after, now) => planned(cadence, after, now), refreshSources: async () => {}, collectResources: async () => {},
    runJob: async (occurrence) => {
      calls += 1;
      if (holdWork) await new Promise<void>(() => {});
      await app.session.commit(async (tx) => {
        const receipts = await tx.doc(Receipts);
        receipts.jobs.push(occurrence);
      }, BACKGROUND_CONTEXT);
    },
  });
  const jobTools = createJobTools(scheduler, app.executions); app.registry.install(jobTools);
  const root = await app.session.root(BACKGROUND_CONTEXT);
  const unbind = app.executions.bind(root.id.toString(), { model: fixtureModel, cwd: "/workspace/example", hosts: [], call: app.call });
  await app.tasks.inference.configure(root, fixtureModel, { extensions: [jobTools] });
  return { ...app, root, scheduler, jobTools, unbind, workCalls: () => calls,
    receipts: () => app.session.snapshot(Receipts, BACKGROUND_CONTEXT) };
}
