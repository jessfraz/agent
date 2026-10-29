import { DAY, FakeClock, START, exampleJob, openBackground, planned, pump } from "./background-runtime.js";

const directory = process.argv[2], boundary = process.argv[3];
if (directory === undefined || (boundary !== "before" && boundary !== "after")) throw new Error("Missing fixture parameters");
const clock = new FakeClock();
const app = await openBackground(directory, clock, {
  plan: async (cadence, after, now) => {
    if (boundary === "before" && cadence.type === "calendar" && after !== null) {
      process.stdout.write("BEFORE\n");
      return new Promise(() => {});
    }
    return planned(cadence, after, now);
  },
  runJob: async () => { process.stdout.write("AFTER\n"); return new Promise(() => {}); },
});
await app.scheduler.start({ poll_interval_seconds: 60, sources: true, jobs: [exampleJob()] });
await pump(async () => (await app.scheduler.getJob("example-review")).schedules[0]?.next_at === START + DAY);
clock.advance(DAY);
// A real durable phase remains in progress until the parent kills this process.
await new Promise<void>(() => { process.stdin.resume(); });
