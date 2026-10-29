import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { reconcileMainInput } from "../src/main_observation.js";

async function open(path: string) {
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(path)),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  return { session, faux };
}

test("stopped placed input reconciles its saved entry across reopen while an unplaced queued input is rejected", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-stopped-input-")), path = join(directory, "session.sqlite");
  let app = await open(path), root: Conversation | undefined;
  try {
    root = await app.session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    app.faux.setResponses([async (_context, options) => {
      const signal = options?.signal; assert.ok(signal); entered();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return fauxAssistantMessage("The interrupted result is not an answer");
    }]);
    const placed = await root.submit({ type: "input", content: "Retain this placed request", requestId: "placed" }, BACKGROUND_CONTEXT);
    await started;
    const queued = await root.submit({ type: "input", content: "Keep this unplaced draft", requestId: "queued", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    assert.equal((await queued.status(BACKGROUND_CONTEXT)).status, "queued");
    await root.abort(BACKGROUND_CONTEXT);
    const placedState = await placed.status(BACKGROUND_CONTEXT), queuedState = await queued.status(BACKGROUND_CONTEXT);
    assert.ok(placedState.status === "unanswered" && placedState.entry !== undefined);
    assert.equal(placedState.reason, "aborted");
    assert.ok(queuedState.status === "unanswered" && queuedState.entry === undefined);
    assert.equal(queuedState.reason, "aborted");
    const entries = (await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id);
    const expected = [{ type: "input_accepted", input_id: "placed" }, { type: "input_placed", input_id: "placed", entry_id: placedState.entry.toString() }];
    let writes = 0;
    const stop = app.session.subscribeCommits((commit) => { writes += commit.changes.length; });
    assert.deepEqual(await reconcileMainInput(root, "placed"), expected,
      "A saved placed input must clear its pending row instead of restoring a duplicate draft");
    const rejected = await reconcileMainInput(root, "queued");
    assert.equal(rejected?.length, 1); assert.equal(rejected?.[0]?.type, "input_rejected");
    assert.equal(await reconcileMainInput(root, "unknown"), undefined);
    stop(); assert.equal(writes, 0); assert.equal(app.faux.state.callCount, 1);
    await app.session.close(BACKGROUND_CONTEXT); root = undefined;
    app = await open(path); root = await app.session.root(BACKGROUND_CONTEXT);
    assert.deepEqual(await reconcileMainInput(root, "placed"), expected);
    assert.equal((await reconcileMainInput(root, "queued"))?.[0]?.type, "input_rejected");
    assert.deepEqual((await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id), entries);
    assert.equal(app.faux.state.callCount, 0, "Reconnect receipts must not run another generation");
  } finally { await root?.abort(BACKGROUND_CONTEXT); await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
