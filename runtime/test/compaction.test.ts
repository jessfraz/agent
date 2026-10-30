import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { CompactionEntry, createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { activity, history, transcript } from "../src/transcript.js";
import { validEvent } from "../src/protocol.js";
import type { ModelActivity } from "../src/generated/ModelActivity.js";
import type { HistoryMessage } from "../src/generated/HistoryMessage.js";

async function open() {
  const directory = await mkdtemp(join(tmpdir(), "agent-compaction-")), models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }, { id: "background", contextWindow: 4096, maxTokens: 256 }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null },
      settings: { compaction: { enabled: false, keepRecentTokens: 0, modelOverrides: {
        "openai/background": { enabled: true, reserveTokens: 512, backgroundTokens: 3584 },
      } }, retry: { enabled: false } } }, BACKGROUND_CONTEXT);
  const root = await session.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "openai", modelId: "fixture" } } });
  faux.setResponses([fauxAssistantMessage("First retained answer"), fauxAssistantMessage("Second retained answer")]);
  for (const content of ["First request", "Second request"]) {
    assert.equal((await (await root.submit({ type: "input", content }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
  }
  return { directory, session, root, faux, async close() { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); } };
}
function record(events: ModelActivity[], event: ModelActivity): void {
  assert.ok(validEvent({ version: 1, id: 1, event: { type: "activity", activity: event } }), "Actual native activity must satisfy the Rust-owned wire schema");
  events.push(event);
}

test("native compaction status survives overlapping work, reattachment and one compaction finishing first", { timeout: 10_000 }, async () => {
  const app = await open(), events: ModelActivity[] = [], restored: ModelActivity[] = [], messages: HistoryMessage[] = [];
  let stop = () => Promise.resolve(), detach = () => Promise.resolve(), releaseFirst = () => {}, releaseSecond = () => {};
  let secondReleased = false; const observed: { active: boolean; secondReleased: boolean }[] = [];
  try {
    stop = await activity(app.session, app.root, (event) => record(events, event), (message) => messages.push(message));
    let enteredFirst = () => {}, enteredSecond = () => {};
    const firstStarted = new Promise<void>((resolve) => { enteredFirst = resolve; }), secondStarted = new Promise<void>((resolve) => { enteredSecond = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; }), secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    app.faux.setResponses([
      async () => { enteredFirst(); await firstGate; return fauxAssistantMessage("PRIVATE_FIRST_SUMMARY"); },
      async () => { enteredSecond(); await secondGate; return fauxAssistantMessage("PRIVATE_SECOND_SUMMARY"); },
      fauxAssistantMessage("Foreground work continues while the native summaries are held"),
    ]);
    const first = await app.root.compact(undefined, BACKGROUND_CONTEXT); await firstStarted;
    const second = await app.root.compact(undefined, BACKGROUND_CONTEXT); await secondStarted;
    const input = await app.root.submit({ type: "input", content: "Continue the current work" }, BACKGROUND_CONTEXT);
    assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.deepEqual(events.filter((event) => event.type === "compaction"), [{ type: "compaction", active: true, failed: false }]);
    detach = await activity(app.session, app.root, (event) => {
      record(restored, event); if (event.type === "compaction") observed.push({ active: event.active, secondReleased });
    }, (message) => messages.push(message));
    assert.deepEqual(restored, [{ type: "compaction", active: true, failed: false }], "Attach must restore actual live compaction without starting another");
    await stop();
    assert.deepEqual(events.at(-1), { type: "compaction", active: false, failed: false }, "Detaching clears only this observation");
    releaseFirst(); assert.equal((await app.session.waitForTask(first, BACKGROUND_CONTEXT)).state.outcome.status, "completed");
    secondReleased = true; releaseSecond();
    assert.equal((await app.session.waitForTask(second, BACKGROUND_CONTEXT)).state.outcome.status, "completed");
    await app.root.waitForIdle(BACKGROUND_CONTEXT); await detach();
    assert.deepEqual(observed, [{ active: true, secondReleased: false }, { active: false, secondReleased: true }],
      "The first completed summary must not clear another live compaction");
    const summaries = (await app.root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.filter(CompactionEntry.is);
    assert.equal(summaries.length, 2, "Both actual native compaction tasks must have written their summaries");
    assert.deepEqual(summaries.flatMap(transcript), [], "Internal checkpoint summaries are not chat messages");
    const visible = await history(app.root, null, app.session);
    for (const value of [events, restored, messages, visible]) assert.equal(JSON.stringify(value).includes("PRIVATE_"), false);
    assert.equal(app.faux.state.callCount, 5);
  } finally { releaseFirst(); releaseSecond(); await stop(); await detach(); await app.close(); }
});

test("native compaction failure and cancellation clear status without leaking provider diagnostics", { timeout: 10_000 }, async () => {
  const app = await open(), events: ModelActivity[] = [];
  let stop = () => Promise.resolve();
  try {
    stop = await activity(app.session, app.root, (event) => record(events, event));
    app.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE_PROVIDER_FAILURE" })]);
    const failed = await app.session.waitForTask(await app.root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    assert.equal(failed.state.outcome.status, "failed"); await stop();
    assert.deepEqual(events.filter((event) => event.type === "compaction"), [
      { type: "compaction", active: true, failed: false }, { type: "compaction", active: false, failed: true },
    ]);
    events.length = 0; stop = await activity(app.session, app.root, (event) => record(events, event));
    let entered = () => {}; const started = new Promise<void>((resolve) => { entered = resolve; });
    app.faux.setResponses([async (_context, options) => {
      const signal = options?.signal; assert.ok(signal); entered();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return fauxAssistantMessage("PRIVATE_ABORTED_SUMMARY");
    }]);
    const cancelled = await app.root.compact(undefined, BACKGROUND_CONTEXT); await started;
    await app.root.abort(BACKGROUND_CONTEXT); assert.equal((await app.session.waitForTask(cancelled, BACKGROUND_CONTEXT)).state.outcome.status, "aborted");
    await stop();
    assert.deepEqual(events.filter((event) => event.type === "compaction"), [
      { type: "compaction", active: true, failed: false }, { type: "compaction", active: false, failed: false },
    ]);
    assert.equal(JSON.stringify(events).includes("PRIVATE_"), false);
  } finally { await stop(); await app.close(); }
});

test("automatic background compaction remains visible when foreground work is interrupted", { timeout: 10_000 }, async () => {
  const app = await open(), events: ModelActivity[] = [];
  let stop = () => Promise.resolve(), release = () => {};
  try {
    stop = await activity(app.session, app.root, (event) => record(events, event));
    await app.root.configure({ model: { provider: "openai", modelId: "background" } }, BACKGROUND_CONTEXT);
    let summarizing = () => {}, generating = () => {};
    const summaryStarted = new Promise<void>((resolve) => { summarizing = resolve; }), generationStarted = new Promise<void>((resolve) => { generating = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const response: Parameters<typeof app.faux.setResponses>[0][number] = async (context, options) => {
      // Native summarization has its own two-message request; foreground
      // generation retains the actual multi-turn conversation.
      if (context.messages.length === 2 && context.messages[0]?.role === "system") {
        summarizing(); await gate; return fauxAssistantMessage("PRIVATE_BACKGROUND_SUMMARY");
      }
      const signal = options?.signal; assert.ok(signal); generating();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return fauxAssistantMessage("Cancelled foreground answer");
    };
    app.faux.setResponses([response, response]);
    const input = await app.root.submit({ type: "input", content: "Continue while native background compaction runs" }, BACKGROUND_CONTEXT);
    await Promise.all([summaryStarted, generationStarted]);
    await app.root.abort(BACKGROUND_CONTEXT); await app.root.waitForIdle(BACKGROUND_CONTEXT);
    const interrupted = await input.wait(BACKGROUND_CONTEXT);
    assert.ok(interrupted.type === "input" && interrupted.status === "unanswered" && interrupted.reason === "aborted");
    const observer = await watchEvents(app.session, app.root.id, BACKGROUND_CONTEXT);
    const [background] = observer.snapshot.compactions; assert.ok(background);
    assert.equal(background.reason, "threshold"); assert.equal(background.blocking, false);
    await observer.stop();
    assert.deepEqual(events.filter((event) => event.type === "compaction"), [{ type: "compaction", active: true, failed: false }]);
    release(); assert.equal((await app.session.waitForTask(background.taskId, BACKGROUND_CONTEXT)).state.outcome.status, "completed");
    await stop();
    assert.deepEqual(events.filter((event) => event.type === "compaction"), [
      { type: "compaction", active: true, failed: false }, { type: "compaction", active: false, failed: false },
    ]);
    assert.equal(JSON.stringify(events).includes("PRIVATE_"), false);
  } finally { release(); await stop(); await app.close(); }
});
