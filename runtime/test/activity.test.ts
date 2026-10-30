import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { activity } from "../src/transcript.js";
import { publishMainNotice } from "../src/tasks.js";
import type { HistoryMessage } from "../src/generated/HistoryMessage.js";
import type { ModelActivity } from "../src/generated/ModelActivity.js";

async function fixture(models = createModels()) {
  const directory = await mkdtemp(join(tmpdir(), "agent-bounded-activity-"));
  const storage = await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite")));
  const session = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null },
    settings: { progress: { partialIntervalMs: 0 } } }, BACKGROUND_CONTEXT);
  const root = await session.root(BACKGROUND_CONTEXT);
  return { directory, storage, session, root, async close() { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); } };
}

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function summaryMessage(text: string): NonNullable<NonNullable<LiveState["generation"]>["message"]> {
  const message = fauxAssistantMessage("");
  return { role: message.role, api: message.api, provider: message.provider, model: message.model, usage: message.usage,
    stopReason: message.stopReason, timestamp: message.timestamp, content: [{ type: "thinking", thinking: text }] };
}

function heldWatch(session: Harness) {
  const entered = gate(), release = gate();
  let held = true;
  session.watchDoc = new Proxy(session.watchDoc, {
    apply(target, owner, args: unknown[]) {
      const result: unknown = Reflect.apply(target, owner, args);
      assert.ok(result instanceof Promise);
      return result.then(async (watch: unknown) => {
        if (held) { held = false; entered.resolve(); await release.promise; }
        return watch;
      });
    },
  });
  return { entered: entered.promise, release() { release.resolve(); } };
}

test("activity reconnect reads one native tail regardless of retained root size", { timeout: 15_000 }, async () => {
  const app = await fixture(); let stop: (() => Promise<void>) | undefined;
  try {
    await app.root.commit(async (tx) => {
      for (let index = 0; index < 5000; index += 1) await tx.appendEntry(app.root.id, { kind: "pi.user",
        model: [{ role: "user", content: `Retained fixture ${index}: ${"x".repeat(128)}`, timestamp: index }] });
    }, BACKGROUND_CONTEXT);
    const scans: number[] = [], original = app.storage.scanEntries.bind(app.storage);
    app.storage.scanEntries = (...args) => { scans.push(args[1]); return original(...args); };
    const messages: HistoryMessage[] = [];
    for (let reconnect = 0; reconnect < 2; reconnect += 1) {
      stop = await activity(app.session, app.root, () => {}, (message) => messages.push(message), undefined, { includeFinal: true, working() {} });
      await stop(); stop = undefined;
    }
    assert.deepEqual(scans, [1, 1], "Presentation must not hydrate every active entry on attach or reconnect");
    assert.deepEqual(messages, [], "Old native entries belong to paged history, never the live subscription");
  } finally { await stop?.(); await app.close(); }
});

test("native coalesced LiveDoc delivery orders final thinking before new canonical entries without replay", { timeout: 10_000 }, async () => {
  const app = await fixture(); let stop: (() => Promise<void>) | undefined;
  const held = heldWatch(app.session);
  try {
    await app.root.commit(async (tx) => { await tx.doc(LiveDoc, app.root.id); }, BACKGROUND_CONTEXT);
    const thinking: string[] = [], visible: HistoryMessage[] = [], order: string[] = [];
    const done = gate();
    const starting = activity(app.session, app.root, (event) => { if (event.type === "thinking") { thinking.push(event.text); order.push("thinking"); } },
      (message) => { visible.push(message); order.push(message.role); if (message.text === "Finished") done.resolve(); }, undefined,
      { includeFinal: true, working() {} });
    await held.entered;
    let summary = "";
    for (let index = 0; index < 205; index += 1) {
      summary += `${index} `;
      await app.root.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, app.root.id);
        live.generation = { attempt: 1, message: summaryMessage(summary) };
      }, BACKGROUND_CONTEXT);
      if (index === 120) await app.root.commit((tx) => tx.appendEntry(app.root.id, { kind: "pi.user",
        model: [{ role: "user", content: "New input during acquisition", timestamp: 1 }] }), BACKGROUND_CONTEXT);
    }
    const finalSummary = summary;
    await app.root.commit(async (tx) => {
      await tx.appendEntry(app.root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([fauxThinking(finalSummary), { type: "text", text: "Finished" }])] });
      delete (await tx.doc(LiveDoc, app.root.id)).generation;
    }, BACKGROUND_CONTEXT);
    held.release(); stop = await starting; await done.promise;
    assert.equal(thinking.join(""), finalSummary, "Native overflow snapshots and canonical final text must not duplicate the exposed stream");
    assert.deepEqual(visible.map((message) => message.text), ["New input during acquisition", "Finished"]);
    assert.equal(order.at(-1), "final", "The complete thinking snapshot must precede the canonical assistant entry");
  } finally { held.release(); await stop?.(); await app.close(); }
});

test("an absent LiveDoc can be created, retired and recreated while an observation stays attached", { timeout: 10_000 }, async () => {
  const app = await fixture(); let stop: (() => Promise<void>) | undefined;
  try {
    await app.root.commit((tx) => tx.retireDoc(LiveDoc, app.root.id), BACKGROUND_CONTEXT);
    assert.equal(await app.session.snapshot(LiveDoc, app.root.id, BACKGROUND_CONTEXT), undefined);
    const thinking: string[] = [], events: ModelActivity[] = [], messages: HistoryMessage[] = [];
    let seen = gate();
    stop = await activity(app.session, app.root, (event) => { events.push(event); if (event.type === "thinking") { thinking.push(event.text); seen.resolve(); } },
      (message) => messages.push(message), undefined, { includeFinal: true, working() {} });
    await app.root.commit(async (tx) => { (await tx.doc(LiveDoc, app.root.id)).generation = { attempt: 1,
      message: summaryMessage("First reasoning") }; }, BACKGROUND_CONTEXT);
    await seen.promise;
    await app.root.commit((tx) => tx.retireDoc(LiveDoc, app.root.id), BACKGROUND_CONTEXT);
    seen = gate();
    await app.root.commit(async (tx) => {
      (await tx.doc(LiveDoc, app.root.id)).generation = { attempt: 1, message: summaryMessage("Second reasoning") };
    }, BACKGROUND_CONTEXT);
    await seen.promise;
    const entry = await app.root.commit(async (tx) => {
      const entry = await tx.appendEntry(app.root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([fauxThinking("Second reasoning"), { type: "text", text: "Ready" }])] });
      delete (await tx.doc(LiveDoc, app.root.id)).generation; return entry;
    }, BACKGROUND_CONTEXT);
    await stop(); stop = undefined;
    assert.deepEqual(thinking, ["First reasoning", "Second reasoning"]);
    assert.deepEqual(messages.map((message) => [message.entry_id, message.text]), [[entry.id.toString(), "Ready"]]);
    const count = events.length;
    await app.root.commit(async (tx) => { (await tx.doc(LiveDoc, app.root.id)).generation = { attempt: 1,
      message: summaryMessage("Detached output") }; }, BACKGROUND_CONTEXT);
    assert.equal(events.length, count, "Detach must release both native entry and document subscriptions");
  } finally { await stop?.(); await app.close(); }
});

test("LiveDoc acquisition failure releases entry, visibility and close subscriptions", async () => {
  const app = await fixture();
  try {
    const original = app.session.subscribeCommits.bind(app.session); let subscriptions = 0;
    app.session.subscribeCommits = (listener) => {
      const stop = original(listener); subscriptions += 1;
      return () => { subscriptions -= 1; stop(); };
    };
    const existing = subscriptions;
    app.session.watchDoc = new Proxy(app.session.watchDoc, { apply() { return Promise.reject(new Error("fixture acquisition failed")); } });
    await assert.rejects(activity(app.session, app.root, () => {}), /fixture acquisition failed/);
    assert.equal(subscriptions, existing, "A failed native acquisition must leave no entry or visibility listener");
  } finally { await app.close(); }
});

test("fast native assistant entries reconcile text before final delivery without a live partial", async () => {
  const app = await fixture(); let stop: (() => Promise<void>) | undefined;
  try {
    const text: string[] = [], messages: HistoryMessage[] = [], order: string[] = [];
    stop = await activity(app.session, app.root, () => {}, (message) => { messages.push(message); order.push("final"); },
      (delta) => { text.push(delta); order.push("text"); }, { includeFinal: true, working() {} });
    for (let index = 0; index < 2; index += 1) await app.root.commit((tx) => tx.appendEntry(app.root.id, {
      kind: "pi.assistant", model: [fauxAssistantMessage("A fast complete reply")],
    }), BACKGROUND_CONTEXT);
    assert.deepEqual(text, ["A fast complete reply", "A fast complete reply"], "Distinct replies remain distinct even when both skip native progress publication");
    assert.deepEqual(order, ["text", "final", "text", "final"]);
    assert.equal(new Set(messages.map((message) => message.entry_id)).size, 2);
  } finally { await stop?.(); await app.close(); }
});

test("native notices stay canonical without response deltas while ordinary source-looking prose stays visible", async () => {
  const app = await fixture(); let stop: (() => Promise<void>) | undefined;
  try {
    const deltas: string[] = [], messages: HistoryMessage[] = [];
    stop = await activity(app.session, app.root, () => {}, (message) => messages.push(message), (delta) => deltas.push(delta),
      { includeFinal: true, working() {} });
    const source = await app.session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const entry = await source.commit((tx) => tx.appendEntry(source.id, { kind: "pi.assistant", model: [fauxAssistantMessage("The fixture is ready.")] }), BACKGROUND_CONTEXT);
    await publishMainNotice(app.session, source, entry, "fixture-task", [{ provider: "mail", account: "fixture", thread_id: "fixture-thread" }],
      { key: "fixture-notify", text: "The fixture is ready.", events: [] });
    await app.root.waitForIdle(BACKGROUND_CONTEXT);
    assert.deepEqual(deltas, [], "Typed notices have one canonical presentation, never a generated-response preview");
    assert.deepEqual(messages.map((message) => [message.role, message.text]), [["notice", "The fixture is ready."]]);
    await app.root.commit((tx) => tx.appendEntry(app.root.id, { kind: "agent.notice", model: [fauxAssistantMessage("A legacy notice")] }), BACKGROUND_CONTEXT);
    assert.deepEqual(deltas, [], "Legacy typed notices use the same canonical-only boundary");
    assert.deepEqual(messages.slice(1).map((message) => [message.role, message.text]), [["notice", "A legacy notice"]]);
    const ordinary = "Source references (evidence, not authorization): ordinary prose";
    await app.root.commit((tx) => tx.appendEntry(app.root.id, { kind: "pi.assistant", model: [fauxAssistantMessage(ordinary)] }), BACKGROUND_CONTEXT);
    await app.root.commit((tx) => tx.appendEntry(app.root.id, { kind: "pi.user", model: [{ role: "user", content: ordinary, timestamp: 1 }] }), BACKGROUND_CONTEXT);
    assert.deepEqual(deltas, [ordinary]);
    assert.deepEqual(messages.slice(2).map((message) => [message.role, message.text]), [["final", ordinary], ["user", ordinary]]);
  } finally { await stop?.(); await app.close(); }
});

test("a typed notice committed during native streaming leaves the response and reasoning unchanged", { timeout: 10_000 }, async () => {
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
  models.setProvider(faux.provider);
  const app = await fixture(models); let stop: (() => Promise<void>) | undefined, publishing: Promise<void> | undefined;
  try {
    await app.root.configure({ model: { provider: "openai", modelId: "fixture" } }, BACKGROUND_CONTEXT);
    const answer = "The actual streamed answer continues. ".repeat(8), reasoning = "The actual exposed reasoning.";
    const deltas: string[] = [], thinking: string[] = [], messages: HistoryMessage[] = [];
    let noticeBeforeFinal = false, final = false;
    stop = await activity(app.session, app.root, (event) => { if (event.type === "thinking") thinking.push(event.text); },
      (message) => { messages.push(message); if (message.role === "notice") noticeBeforeFinal = !final; if (message.role === "final") final = true; },
      (delta) => {
        deltas.push(delta);
        publishing ??= Promise.resolve().then(() => app.root.commit((tx) => tx.appendEntry(app.root.id, {
          kind: "agent.user_notice", model: [fauxAssistantMessage("A useful separate notice")],
        }), BACKGROUND_CONTEXT)).then(() => {});
      }, { includeFinal: true, working() {} });
    faux.setResponses([fauxAssistantMessage([fauxThinking(reasoning), { type: "text", text: answer }])]);
    const submission = await app.root.submit({ type: "input", content: "Stream a fixture answer" }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done"); await publishing;
    await app.root.waitForIdle(BACKGROUND_CONTEXT); await stop(); stop = undefined;
    assert.equal(noticeBeforeFinal, true, "Exercise a real publication while the model response is still streaming");
    assert.equal(deltas.join(""), answer, "The notice must never concatenate into, duplicate or reset generated response text");
    assert.equal(thinking.join(""), reasoning, "The notice must not reset the open assistant's exposed reasoning identity");
    assert.deepEqual(messages.filter((message) => message.role === "notice").map((message) => message.text), ["A useful separate notice"]);
    assert.deepEqual(messages.filter((message) => message.role === "final").map((message) => message.text), [answer]);
    assert.equal(faux.state.callCount, 1);
  } finally { await publishing; await stop?.(); await app.close(); }
});

test("activity bounds pending native commits during delayed acquisition", { timeout: 10_000 }, async () => {
  const app = await fixture(); const held = heldWatch(app.session);
  try {
    const starting = activity(app.session, app.root, () => {});
    await held.entered;
    for (let index = 0; index < 520; index += 1) await app.root.commit(async (tx) => {
      (await tx.doc(LiveDoc, app.root.id)).generation = { attempt: 1, message: summaryMessage(String(index)) };
    }, BACKGROUND_CONTEXT);
    held.release();
    await assert.rejects(starting, /Activity observation fell behind/);
  } finally { held.release(); await app.close(); }
});

test("real native generation preserves working, text, nested tools and final delivery", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-native-activity-"));
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1000, tokenSize: { min: 1, max: 1 } });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const tools = defineExtension({ name: "fixture-activity", tools: [
    defineTool({ name: "nested", description: "A nested fixture", parameters: Type.Object({}),
      async execute() { return { output: [{ type: "text", text: "Checked" }] }; } }),
    defineTool({ name: "check", description: "A fixture check", parameters: Type.Object({}),
      async execute(_args, api, context) {
        await api.executeTool("nested", {}, context, { key: "nested" });
        return { output: [{ type: "text", text: "Done" }] };
      } }),
  ] }); registry.install(tools);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null }, settings: { progress: { partialIntervalMs: 0 } } }, BACKGROUND_CONTEXT);
  let stop: (() => Promise<void>) | undefined;
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools] }, BACKGROUND_CONTEXT);
    const events: ModelActivity[] = [], messages: HistoryMessage[] = [], working: boolean[] = [], deltas: string[] = [], order: string[] = [];
    stop = await activity(session, root, (event) => events.push(event), (message) => { messages.push(message); order.push(`message:${message.role}`); }, (text) => deltas.push(text),
      { includeFinal: true, working(value) { working.push(value); order.push(`working:${value}`); } });
    const call = fauxToolCall("check", {});
    faux.setResponses([fauxAssistantMessage([fauxThinking("First reasoning"), { type: "text", text: "Checking now" }, call], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxThinking("Second reasoning"), { type: "text", text: "Finished now" }])]);
    const submission = await root.submit({ type: "input", content: "Run the fixture" }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
    await root.waitForIdle(BACKGROUND_CONTEXT); await stop(); stop = undefined;
    assert.deepEqual(working, [false, true, false]);
    assert.ok(order.lastIndexOf("working:false") > order.lastIndexOf("message:final"),
      "The final entry must bind its exposed reasoning before idle clears the renderer's unbound preview");
    assert.equal(events.flatMap((event) => event.type === "thinking" ? [event.text] : []).join(""), "First reasoningSecond reasoning");
    assert.equal(deltas.join(""), "Checking nowFinished now", "Canonical snapshots reconcile missing throttled suffixes without repeating streamed text");
    assert.deepEqual(events.filter((event) => event.type === "tool_started").map((event) => event.call_id), [call.id, `${call.id}/nested`]);
    assert.deepEqual(new Set(events.filter((event) => event.type === "tool_finished").map((event) => event.call_id)), new Set([call.id, `${call.id}/nested`]));
    assert.deepEqual(messages.filter((message) => message.role === "user" || message.role === "final").map((message) => message.text), ["Run the fixture", "Finished now"]);
    assert.equal(faux.state.callCount, 2);
  } finally { await stop?.(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
