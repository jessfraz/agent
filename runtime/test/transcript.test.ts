import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, defineExtension, defineTool, watchEvents, type AgentEvent } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { activity, history, isUserNotice, transcript } from "../src/transcript.js";
import { HistoryStore } from "../src/history.js";
import type { HistoryMessage } from "../src/generated/HistoryMessage.js";
import type { HistoryItem } from "../src/generated/HistoryItem.js";
import { validEvent } from "../src/protocol.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import { publishMainNotice } from "../src/tasks.js";

test("native history pagination stays on one conversation, survives reopen and never renders signatures or tool arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-transcript-"));
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  const storage = await SqliteStorage.open(database); const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const session = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  let rootId = "";
  try {
    const root = await session.root(BACKGROUND_CONTEXT); rootId = root.id.toString();
    for (let index = 0; index < 45; index += 1) await root.commit((tx) => tx.appendEntry(root.id, {
      kind: "fixture.history", model: [
        { role: "user", content: `Stored question ${index}`, timestamp: index },
        fauxAssistantMessage(`Stored answer ${index}`),
      ],
    }), BACKGROUND_CONTEXT);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "fixture.reasoning", model: [
      fauxAssistantMessage([{ ...fauxThinking("Public provider summary"), thinkingSignature: "opaque-signature" },
        fauxToolCall("exec", { program: "private-argument" })]),
    ] }), BACKGROUND_CONTEXT);
    const first = await history(root, null, session); let cursor = first.at(-1)?.next_cursor ?? null;
    const visible = first.flatMap((frame) => frame.messages);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "fixture.newer", model: [
      { role: "user", content: "A newer message must not shift older pages", timestamp: 100 },
    ] }), BACKGROUND_CONTEXT);
    while (cursor !== null) {
      const page = await history(root, cursor, session); visible.push(...page.flatMap((frame) => frame.messages));
      cursor = page.at(-1)?.next_cursor ?? null;
    }
    assert.equal(visible.filter((message) => message.role === "user").length, 45);
    assert.equal(new Set(visible.filter((message) => message.role === "user").map((message) => message.text)).size, 45);
    assert.ok(visible.some((message) => message.role === "thinking" && message.text === "Public provider summary"));
    const tools = visible.filter((message) => message.role === "tool");
    assert.deepEqual(tools.map((message) => message.text), [""]);
    assert.deepEqual(tools[0]?.presentation, { type: "command", exit_code: null, duration_ms: null });
    assert.equal(JSON.stringify(visible).includes("opaque-signature"), false);
    assert.equal(JSON.stringify(visible).includes("private-argument"), false);
    const other = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await assert.rejects(history(other, first.at(-1)?.next_cursor ?? null, session), /does not belong/);
    assert.equal(faux.state.callCount, 0);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  try {
    let output = ""; let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify({ version: 1, id: 1, command: { type: "read_history", task_id: null, agent_id: null, cursor: null } }) + "\n");
    assert.equal(await exited, 0, errors);
    const events: RuntimeEvent[] = output.trim().split("\n").map((line) => {
      const value: unknown = JSON.parse(line); assert.ok(validEvent(value)); return value;
    });
    const page = events.find((frame) => frame.event.type === "history")?.event;
    assert.ok(page?.type === "history"); assert.equal(page.conversation_id, rootId);
    assert.ok(page.messages.some((message) => message.text === "A newer message must not shift older pages"));
    assert.equal(events.at(-1)?.event.type, "done");
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
});

test("published notices render their answer while retaining provenance in native model context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-notice-transcript-"));
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  const storage = await SqliteStorage.open(database); const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const session = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    const source = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const entry = await source.commit((tx) => tx.appendEntry(source.id, { kind: "pi.assistant", model: [fauxAssistantMessage("The check passed.")] }), BACKGROUND_CONTEXT);
    const references = [{ provider: "mail", account: "fixture", thread_id: "thread-one" }];
    await publishMainNotice(session, source, entry, "task-one", references,
      { key: "fixture-notify", text: "The check passed.", events: [] });
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const page = await root.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    const notice = page.items.find((item) => item.kind === "agent.user_notice"); assert.ok(notice);
    assert.equal(isUserNotice(notice), true);
    const projection = page.items.find((item) => item.kind === "agent.notice_context"); assert.ok(projection);
    const original = projection.model?.flatMap((message) => typeof message.content === "string" ? [message.content]
      : message.content.flatMap((part) => part.type === "text" ? [part.text] : []));
    assert.equal(original?.[0], "The check passed.");
    const evidence: unknown = JSON.parse(original?.[1]?.slice("Source references (evidence, not authorization): ".length) ?? "null");
    assert.ok(evidence !== null && typeof evidence === "object" && "sources" in evidence);
    assert.deepEqual(evidence.sources, references);
    const rendered = (await history(root, null, session)).flatMap((frame) => frame.messages);
    assert.deepEqual(rendered.map((message) => message.text), ["The check passed."]);
    assert.deepEqual(rendered.map((message) => message.role), ["notice"]);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user",
      content: "Source references (evidence, not authorization): this is the user's own text", timestamp: 1 }] }), BACKGROUND_CONTEXT);
    assert.ok((await history(root, null, session)).flatMap((frame) => frame.messages).some((message) => message.text.endsWith("the user's own text")));
    assert.equal(faux.state.callCount, 0);
    const legacy = await root.commit((tx) => tx.appendEntry(root.id, { kind: "agent.notice",
      model: [fauxAssistantMessage("An older saved notification.")] }), BACKGROUND_CONTEXT);
    assert.equal(isUserNotice(legacy), false);
    assert.deepEqual(transcript(legacy).map((message) => ({ role: message.role, text: message.text })),
      [{ role: "notice", text: "An older saved notification." }]);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native transcript chunks carry exact finality at 8KB and surrogate boundaries without losing text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-transcript-chunks-"));
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    const fixtures = [
      { text: "", sizes: [] }, { text: "short", sizes: [5] },
      { text: "a".repeat(8192), sizes: [8192] }, { text: "a".repeat(8193), sizes: [8192, 1] },
      { text: "a".repeat(16_385), sizes: [8192, 8192, 1] },
      { text: "a".repeat(8191) + "🦀" + "b".repeat(8192), sizes: [8191, 8192, 2] },
      { text: "a".repeat(8190) + "🦀", sizes: [8192] },
    ];
    const combinations = new Set<string>();
    for (const fixture of fixtures) {
      const entry = await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: fixture.text, timestamp: 1 }] }), BACKGROUND_CONTEXT);
      const projected = transcript(entry);
      assert.deepEqual(projected.map((message) => message.text.length), fixture.sizes);
      assert.equal(projected.map((message) => message.text).join(""), fixture.text);
      assert.deepEqual(projected.map((message) => [message.continuation, message.final_chunk]),
        fixture.sizes.map((_, index) => [index > 0, index === fixture.sizes.length - 1]));
      for (const message of projected) {
        combinations.add(`${message.continuation}:${message.final_chunk}`);
        const first = message.text.charCodeAt(0), last = message.text.charCodeAt(message.text.length - 1);
        assert.equal(first >= 0xdc00 && first <= 0xdfff, false); assert.equal(last >= 0xd800 && last <= 0xdbff, false);
      }
      const frames = await history(root, null, session);
      for (const event of frames) assert.ok(validEvent({ version: 1, id: 1, event }));
      assert.deepEqual(frames.flatMap((frame) => frame.messages).filter((message) => message.entry_id === entry.id.toString()), projected);
    }
    assert.deepEqual([...combinations].sort(), ["false:false", "false:true", "true:false", "true:true"]);
    assert.equal(faux.state.callCount, 0);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native phases and old inert Codex metadata project consistently before and after SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-message-kinds-"));
  const models = createModels(); const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const registry = createRegistry();
  const tools = defineExtension({ name: "phase-fixture", tools: [defineTool({ name: "check", description: "Run the check", parameters: Type.Object({}),
    async execute() { return { output: [{ type: "text", text: "Checked" }] }; } })] }); registry.install(tools);
  const open = async () => Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  let session = await open(); let stop: (() => Promise<void>) | undefined;
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools] }, BACKGROUND_CONTEXT);
    const live: HistoryMessage[] = [];
    stop = await activity(session, root, () => {}, (message) => live.push(message));
    faux.setResponses([
      fauxAssistantMessage([{ type: "text", text: "Checking the result." }, fauxToolCall("check", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("The result is ready.", { stopReason: "stop" }),
    ]);
    await (await root.submit({ type: "input", content: "Check the result" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT); await stop(); stop = undefined;
    assert.deepEqual(live.filter((message) => message.text === "Checking the result.").map((message) => message.role), ["commentary"]);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "fixture.unknown", model: [fauxAssistantMessage("This sounds final, but its source did not finish.", { stopReason: "length" })] }), BACKGROUND_CONTEXT);
    const source = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const report = await source.commit((tx) => tx.appendEntry(source.id, { kind: "pi.assistant", model: [fauxAssistantMessage("The background result is ready.")] }), BACKGROUND_CONTEXT);
    await publishMainNotice(session, source, report, "fixture-task", [],
      { key: "fixture-notify", text: "The background result is ready.", events: [] }); await root.waitForIdle(BACKGROUND_CONTEXT);
    const before = (await history(root, null, session)).flatMap((frame) => frame.messages);
    assert.equal(before.find((message) => message.text === "Checking the result.")?.role, "commentary");
    assert.equal(before.find((message) => message.text === "The result is ready.")?.role, "final");
    assert.equal(before.find((message) => message.text.startsWith("This sounds final"))?.role, "assistant");
    assert.equal(before.find((message) => message.text === "The background result is ready.")?.role, "notice");

    const phases = ["commentary", "final_answer", null, undefined, "future_phase", "partial_answer"];
    const items: HistoryItem[] = phases.map((phase, index) => ({ id: `item-${index}`, turn_id: "turn", kind: "agentMessage", role: "assistant",
      text: `Preserved text ${index}`, version: "v1", order: index, timestamp_ms: null,
      data: phase === undefined ? { type: "agentMessage", text: `Preserved text ${index}` } : { type: "agentMessage", phase, text: `Preserved text ${index}` }, assets: [] }));
    items.push({ id: "cold", turn_id: "turn", kind: "agentMessage", role: "assistant", text: "Cold evidence has no inline phase", version: "v1", order: 6, timestamp_ms: null, data: null, assets: [] });
    items.push({ id: "plan", turn_id: "turn", kind: "plan", role: "assistant", text: "A saved plan is not a known final phase", version: "v1", order: 7, timestamp_ms: null, data: { type: "plan" }, assets: [] });
    const store = new HistoryStore(session);
    await store.import({ host_id: "fixture", thread: { id: "thread", title: "Saved work", cwd: "/workspace", created_at: 1, updated_at: 2, forked_from_id: null,
      parent_thread_id: null, version: "v1", version_reliable: true, archived: false }, items, complete: true, next_cursor: null, gaps: [] });
    const imported = await store.get("thread"); assert.ok(imported);
    const conversation = await store.conversation(imported.conversation_id); assert.ok(conversation);
    const original = (await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items;
    const importedFrames = await history(conversation, null, session);
    for (const event of importedFrames) assert.ok(validEvent({ version: 1, id: 1, event }), "Projected semantic roles must satisfy the generated wire contract");
    const projected = importedFrames.flatMap((frame) => frame.messages);
    assert.deepEqual(projected.map((message) => message.role), ["commentary", "final", "assistant", "assistant", "assistant", "partial_answer", "assistant", "assistant"]);
    assert.deepEqual((await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items, original, "Rendering must never rewrite retained evidence");
    const calls = faux.state.callCount;
    await session.close(BACKGROUND_CONTEXT); session = await open();
    const reopened = await session.root(BACKGROUND_CONTEXT);
    assert.deepEqual((await history(reopened, null, session)).flatMap((frame) => frame.messages), before);
    const old = await new HistoryStore(session).conversation(imported.conversation_id); assert.ok(old);
    assert.deepEqual((await history(old, null, session)).flatMap((frame) => frame.messages), projected);
    assert.equal(faux.state.callCount, calls, "Reopening or projecting imports must not run inference");
  } finally { await stop?.(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("hidden compaction-only native pages do not hide the next visible history or expose summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hidden-history-"));
  const models = createModels(); const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: "The earlier visible request", timestamp: 1 }] }), BACKGROUND_CONTEXT);
    for (let index = 0; index < 45; index += 1) await root.commit((tx) => tx.appendEntry(root.id,
      { kind: "pi.compaction", model: [{ role: "user", content: `Internal compaction payload ${index}`, timestamp: index + 2 }] }), BACKGROUND_CONTEXT);
    const frames = await history(root, null, session);
    assert.deepEqual(frames.flatMap((frame) => frame.messages).map((message) => message.text), ["The earlier visible request"]);
    assert.equal(frames.at(-1)?.next_cursor, null);
    const hidden = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    for (let index = 0; index < 25; index += 1) await hidden.commit((tx) => tx.appendEntry(hidden.id,
      { kind: "pi.compaction", model: [{ role: "user", content: "Internal only", timestamp: index }] }), BACKGROUND_CONTEXT);
    const empty = await history(hidden, null, session);
    assert.equal(empty.flatMap((frame) => frame.messages).length, 0); assert.equal(empty.at(-1)?.next_cursor, null);
    assert.equal(faux.state.callCount, 0);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

for (const failed of [false, true]) test(`native tool identity survives a mid-run history reopen and a persisted ${failed ? "failed" : "finished"} result`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tool-history-"));
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  let release = () => {}, entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const tools = defineExtension({ name: "held-history-check", tools: [defineTool({ name: "check", description: "Hold the check", parameters: Type.Object({}),
    async execute() { entered(); await held; return { output: [{ type: "text", text: failed ? "The check failed" : "Checked" }], isError: failed }; } })] }); registry.install(tools);
  const open = async () => Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  let session = await open(), stop: (() => Promise<void>) | undefined;
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools] }, BACKGROUND_CONTEXT);
    const call = fauxToolCall("check", {});
    faux.setResponses([fauxAssistantMessage([fauxThinking("Reasoning before the check"), { type: "text", text: "Checking" }, call], { stopReason: "toolUse" }),
      fauxAssistantMessage("The check ended")]);
    stop = await activity(session, root, () => {});
    const running = await root.submit({ type: "input", content: "Check the stored identity" }, BACKGROUND_CONTEXT);
    await started;
    const presentation = { type: "tool", namespace: null };
    const partial = (await history(root, null, session)).flatMap((frame) => frame.messages);
    assert.deepEqual(partial.filter((message) => message.role === "tool").map((message) => ({ ...message, entry_id: "native-entry" })),
      [{ entry_id: "native-entry", role: "tool", text: "", continuation: false, final_chunk: true, presentation, tool: { call_id: call.id, name: "check", status: "running" } }]);
    await stop(); stop = undefined;
    assert.deepEqual((await history(root, null, session)).flatMap((frame) => frame.messages), partial, "Opening history while the tool is held must retain its native identity");
    const live: HistoryMessage[] = [];
    stop = await activity(session, root, () => {}, (message) => live.push(message));
    release(); assert.equal((await running.wait(BACKGROUND_CONTEXT)).status, "done");
    await root.waitForIdle(BACKGROUND_CONTEXT); await stop(); stop = undefined;
    const result = { call_id: call.id, name: "check", status: failed ? "failed" : "finished" };
    const output = failed ? "The check failed" : "Checked";
    assert.deepEqual(live.filter((message) => message.role === "tool").map((message) => ({ ...message, entry_id: "native-entry" })),
      [{ entry_id: "native-entry", role: "tool", text: output, continuation: false, final_chunk: true, presentation, tool: result }]);
    const completed = (await history(root, null, session)).flatMap((frame) => frame.messages);
    assert.deepEqual(completed.filter((message) => message.role === "tool").map((message) => ({ ...message, entry_id: "native-entry" })),
      [{ entry_id: "native-entry", role: "tool", text: "", continuation: false, final_chunk: true, presentation, tool: { call_id: call.id, name: "check", status: "running" } },
        { entry_id: "native-entry", role: "tool", text: output, continuation: false, final_chunk: true, presentation, tool: result }]);
    await session.close(BACKGROUND_CONTEXT); session = await open();
    assert.deepEqual((await history(await session.root(BACKGROUND_CONTEXT), null, session)).flatMap((frame) => frame.messages), completed);
    assert.equal(faux.state.callCount, 2, "Reading or reopening tool history must not run another generation");
  } finally { release(); await stop?.(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("native thinking updates and final snapshots render each block once while preserving identical distinct blocks", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-thinking-transcript-"));
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  const storage = await SqliteStorage.open(database); const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } }); models.setProvider(faux.provider);
  const registry = createRegistry();
  const tools = defineExtension({ name: "fixture-check", tools: [defineTool({ name: "check", description: "Run a synthetic check", parameters: Type.Object({}),
    async execute() { return { output: [{ type: "text", text: "Checked" }] }; } })] }); registry.install(tools);
  const session = await Harness.open(storage, { models, registry, identity: { attribution: null }, settings: { progress: { partialIntervalMs: 0 } } }, BACKGROUND_CONTEXT);
  const events: AgentEvent[] = []; const thinking: string[] = [];
  let stop: (() => Promise<void>) | undefined; let stopNative: (() => Promise<unknown>) | undefined;
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools] }, BACKGROUND_CONTEXT);
    let interleaved = false;
    const native = await watchEvents(session, root.id, BACKGROUND_CONTEXT); native.start(async (batch) => {
      events.push(...batch);
      if (!interleaved && batch.some((event) => event.type === "message_update" && event.changes.some((change) => change.type === "text_delta"))) {
        interleaved = true;
        await root.commit((tx) => tx.appendEntry(root.id, { kind: "fixture.concurrent", model: [
          { role: "user", content: "Concurrent stored message while the assistant streams", timestamp: 1 },
        ] }), BACKGROUND_CONTEXT);
      }
    }); stopNative = () => native.stop();
    stop = await activity(session, root, (event) => { if (event.type === "thinking") thinking.push(event.text); });
    const summary = "The public summary is the same.";
    faux.setResponses([
      fauxAssistantMessage([fauxThinking(summary), fauxThinking(summary), { type: "text", text: "Streaming commentary before the check." }, fauxToolCall("check", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxThinking(summary), { type: "text", text: "Finished." }]),
    ]);
    await (await root.submit({ type: "input", content: "Check and finish" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT); await stop?.(); stop = undefined; await stopNative?.(); stopNative = undefined;
    assert.ok(events.some((event) => event.type === "message_update"), "Exercise actual native streamed updates");
    assert.ok(events.some((event) => event.type === "message_end"), "Exercise actual native final snapshots");
    assert.equal(interleaved, true, "Exercise an unrelated native message_start during the same assistant's progress");
    assert.equal(thinking.join(""), summary.repeat(3));
    assert.equal(faux.state.callCount, 2);
  } finally { await stop?.(); await stopNative?.(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});


test("native history pages mark only their final frame independently of worker lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-history-page-"));
  const models = createModels();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    for (let index = 0; index < 25; index += 1) await root.commit((tx) => tx.appendEntry(root.id, {
      kind: "fixture.history", model: [{ role: "user", content: `Saved ${index}: ` + "x".repeat(9000), timestamp: index }],
    }), BACKGROUND_CONTEXT);
    const frames = await history(root, null, session);
    assert.ok(frames.length > 1, "Native history must exercise a page split across transport frames");
    assert.deepEqual(frames.map((frame) => frame.page_complete), frames.map((_, index) => index === frames.length - 1));
    assert.ok(frames.at(-1)?.next_cursor, "Page completion is independent from exhausting older history");
    assert.ok(frames.slice(0, -1).every((frame) => frame.next_cursor === null));
    for (const event of frames) assert.ok(validEvent({ version: 1, id: 1, event }));
    const tail = frames.at(-1); assert.ok(tail);
    const older = await history(root, tail.next_cursor, session);
    assert.equal(older.at(-1)?.page_complete, true); assert.equal(older.at(-1)?.next_cursor, null);
    const empty = await history(await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT), null, session);
    assert.equal(empty.length, 1); assert.equal(empty[0]?.page_complete, true); assert.deepEqual(empty[0]?.messages, []);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
