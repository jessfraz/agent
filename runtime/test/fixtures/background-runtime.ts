import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, type SetTimer } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BackgroundScheduler, type BackgroundCallbacks } from "../../src/background.js";
import type { BackgroundCadence } from "../../src/generated/BackgroundCadence.js";
import type { OccurrencePlan } from "../../src/generated/OccurrencePlan.js";
import type { ScheduledJob } from "../../src/generated/ScheduledJob.js";
import type { ScheduledOccurrence } from "../../src/generated/ScheduledOccurrence.js";
import { fixtureModel } from "../model.js";
import { TaskStore } from "../../src/tasks.js";

export const DAY = 86_400_000;
export const START = Date.UTC(2027, 0, 1, 9);
export class FakeClock {
  private serial = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  constructor(public value = START) {}
  readonly now = () => this.value;
  readonly setTimer: SetTimer = (callback, delay) => {
    const id = ++this.serial;
    this.timers.set(id, { at: this.value + delay, callback });
    return () => { this.timers.delete(id); };
  };
  advance(milliseconds: number): void {
    this.value += milliseconds;
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.value);
    for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
  }
}
export function exampleJob(revision = "one", prompt = "Review the example sources."): ScheduledJob {
  return { id: "example-review", title: "Example review", prompt, revision, cwd: "/workspace/example", model: fixtureModel,
    timezone: "Etc/UTC", schedules: [{ id: "daily", recurrence: "DTSTART;TZID=Etc/UTC:20270101T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", focus: null, prompt: null }] };
}
/** Controlled planner boundary; Rust tests own recurrence and timezone calculation. */
export function planned(cadence: BackgroundCadence, after: number | null, now: number): OccurrencePlan {
  if (cadence.type === "interval") {
    const interval = cadence.seconds * 1000;
    if (after === null) return { due: now, next: now + interval };
    const count = Math.max(0, Math.floor((now - after) / interval));
    return { due: count > 0 ? after + count * interval : null, next: after + (count + 1) * interval };
  }
  const index = Math.max(0, Math.floor((now - START) / DAY));
  const latest = START + index * DAY;
  return { due: after !== null && latest > after ? latest : null, next: START + (index + 1) * DAY };
}
export const Receipts = defineDoc<{ jobs: ScheduledOccurrence[]; sources: number; resources: number }>({
  kind: "test.background-receipts", scope: "session", version: 1,
  initial: () => ({ jobs: [], sources: 0, resources: 0 }), checkpointWhen: () => true,
});
export async function pump(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Background work did not reach its expected durable state");
}
export async function openBackground(directory: string, clock: FakeClock, overrides: Partial<BackgroundCallbacks> = {}) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(database), { models: createModels(), registry,
    now: clock.now, setTimer: clock.setTimer, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session);
  const scheduler = new BackgroundScheduler(session, registry, tasks, {
    plan: async (cadence, after, now) => planned(cadence, after, now),
    refreshSources: async () => { await session.commit(async (tx) => { (await tx.doc(Receipts)).sources += 1; }, BACKGROUND_CONTEXT); },
    collectResources: async () => { await session.commit(async (tx) => { (await tx.doc(Receipts)).resources += 1; }, BACKGROUND_CONTEXT); },
    runJob: async (occurrence) => { await session.commit(async (tx) => {
      const receipts = await tx.doc(Receipts);
      if (!receipts.jobs.some((job) => job.id === occurrence.id)) receipts.jobs.push(occurrence);
    }, BACKGROUND_CONTEXT); },
    ...overrides,
  });
  return { session, scheduler, tasks, registry, receipts: () => session.snapshot(Receipts, BACKGROUND_CONTEXT) };
}
