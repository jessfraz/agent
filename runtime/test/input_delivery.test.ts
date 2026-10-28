import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { watchInputPlacements } from "../src/input_delivery.js";
import { activity } from "../src/transcript.js";

type Delivery = { type: "accepted"; input_id: string } | { type: "placed"; conversation_id: string; input_id: string; entry_id: string }
  | { type: "message"; entry_id: string; text: string };

test("native placement follows queued admission, precedes transcript publication and preserves distinct identical inputs", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-input-delivery-"));
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  let release = () => {}, entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const tools = defineExtension({ name: "held-check", tools: [defineTool({ name: "check", description: "Hold the current check", parameters: Type.Object({}),
    async execute() { entered(); await held; return { output: [{ type: "text", text: "Checked" }] }; } })] }); registry.install(tools);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null }, settings: { steeringMode: "all", followUpMode: "one-at-a-time" } }, BACKGROUND_CONTEXT);
  let stopMessages: (() => Promise<void>) | undefined, stopPlacements = () => {};
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools] }, BACKGROUND_CONTEXT);
    const delivery: Delivery[] = [];
    // Acquire the asynchronous native transcript observer first; placement must
    // still be announced synchronously before it receives the committed entry.
    stopMessages = await activity(session, root, () => {}, (message) => {
      if (message.role === "user") delivery.push({ type: "message", entry_id: message.entry_id, text: message.text });
    });
    stopPlacements = watchInputPlacements(session, (conversation_id, input_id, entry_id) => {
      delivery.push({ type: "placed", conversation_id, input_id, entry_id });
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("check", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("The corrected result"), fauxAssistantMessage("First later result"), fauxAssistantMessage("Second later result"),
      fauxAssistantMessage("Unidentified result"), fauxAssistantMessage("Result after disposal"),
    ]);
    const original = await root.submit({ type: "input", requestId: "original", content: "Start the check" }, BACKGROUND_CONTEXT);
    await started;
    const first = await root.submit({ type: "input", requestId: "queued-one", content: "The identical later request", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    delivery.push({ type: "accepted", input_id: "queued-one" });
    const second = await root.submit({ type: "input", requestId: "queued-two", content: "The identical later request", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    delivery.push({ type: "accepted", input_id: "queued-two" });
    const steer = await root.submit({ type: "input", requestId: "correction", content: "Correct the current check", whenBusy: "steer" }, BACKGROUND_CONTEXT);
    delivery.push({ type: "accepted", input_id: "correction" });
    for (const input of [first, second, steer]) assert.equal((await input.status(BACKGROUND_CONTEXT)).status, "queued");
    assert.deepEqual(delivery.filter((event) => event.type === "placed").map((event) => event.input_id), ["original"],
      "Durable admission must not claim that a busy input is already in the transcript");
    release();
    const [initial, corrected, queuedFirst, queuedSecond] = await Promise.all([original.wait(BACKGROUND_CONTEXT), steer.wait(BACKGROUND_CONTEXT),
      first.wait(BACKGROUND_CONTEXT), second.wait(BACKGROUND_CONTEXT)]);
    await root.waitForIdle(BACKGROUND_CONTEXT); await stopMessages(); stopMessages = undefined;
    assert.ok(initial.type === "input" && initial.status === "done");
    assert.ok(corrected.type === "input" && corrected.status === "done");
    assert.ok(queuedFirst.type === "input" && queuedFirst.status === "done");
    assert.ok(queuedSecond.type === "input" && queuedSecond.status === "done");
    assert.equal(corrected.answer, initial.answer, "Steering must continue the original native run instead of cancelling it");
    assert.notEqual(queuedFirst.answer, queuedSecond.answer, "Explicitly queued inputs own separate later answers");
    const placed = delivery.filter((event) => event.type === "placed");
    assert.deepEqual(placed.map((event) => event.input_id), ["original", "correction", "queued-one", "queued-two"]);
    assert.ok(placed.every((event) => event.conversation_id === root.id.toString()));
    assert.equal(new Set(placed.map((event) => event.entry_id)).size, 4);
    for (const event of placed) {
      const placement = delivery.indexOf(event);
      const canonical = delivery.findIndex((item) => item.type === "message" && item.entry_id === event.entry_id);
      assert.ok(canonical > placement, `${event.input_id} must be correlated before its canonical message is delivered`);
      if (event.input_id !== "original") assert.ok(delivery.findIndex((item) => item.type === "accepted" && item.input_id === event.input_id) < placement);
    }
    const duplicateBodies = delivery.filter((event) => event.type === "message").filter((event) => event.text === "The identical later request");
    assert.equal(duplicateBodies.length, 2); assert.equal(new Set(duplicateBodies.map((event) => event.entry_id)).size, 2);
    assert.equal(faux.state.callCount, 4, "Placement observation must neither cancel nor create inference");
    assert.equal((await root.submit({ type: "input", requestId: "queued-one", content: "The identical later request" }, BACKGROUND_CONTEXT)).id, first.id);
    assert.equal(delivery.filter((event) => event.type === "placed").length, 4, "A native request retry must not publish another placement");
    await (await root.submit({ type: "input", content: "No request identifier" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await (await root.submit({ type: "write", requestId: "passive", entry: { kind: "fixture.note", data: { text: "Passive note" } } }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(delivery.filter((event) => event.type === "placed").length, 4, "Unidentified input and passive writes are not correlated controls");
    stopPlacements(); stopPlacements();
    await (await root.submit({ type: "input", requestId: "after-disposal", content: "Continue after disposal" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(delivery.filter((event) => event.type === "placed").length, 4, "Disposal must stop observing subsequent commits");
  } finally { release(); stopPlacements(); await stopMessages?.(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
