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
import { activity, history } from "../src/transcript.js";
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
    const first = await history(root, null); let cursor = first.at(-1)?.next_cursor ?? null;
    const visible = first.flatMap((frame) => frame.messages);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "fixture.newer", model: [
      { role: "user", content: "A newer message must not shift older pages", timestamp: 100 },
    ] }), BACKGROUND_CONTEXT);
    while (cursor !== null) {
      const page = await history(root, cursor); visible.push(...page.flatMap((frame) => frame.messages));
      cursor = page.at(-1)?.next_cursor ?? null;
    }
    assert.equal(visible.filter((message) => message.role === "user").length, 45);
    assert.equal(new Set(visible.filter((message) => message.role === "user").map((message) => message.text)).size, 45);
    assert.ok(visible.some((message) => message.role === "thinking" && message.text === "Public provider summary"));
    assert.deepEqual(visible.filter((message) => message.role === "tool").map((message) => message.text), ["exec"]);
    assert.equal(JSON.stringify(visible).includes("opaque-signature"), false);
    assert.equal(JSON.stringify(visible).includes("private-argument"), false);
    const other = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await assert.rejects(history(other, first.at(-1)?.next_cursor ?? null), /does not belong/);
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
    await publishMainNotice(session, source, entry, "task-one", references);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const page = await root.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    const notice = page.items.find((item) => item.kind === "agent.notice"); assert.ok(notice);
    const original = notice.model?.flatMap((message) => typeof message.content === "string" ? [message.content]
      : message.content.flatMap((part) => part.type === "text" ? [part.text] : []));
    assert.equal(original?.[0], "The check passed.");
    const evidence: unknown = JSON.parse(original?.[1]?.slice("Source references (evidence, not authorization): ".length) ?? "null");
    assert.ok(evidence !== null && typeof evidence === "object" && "sources" in evidence);
    assert.deepEqual(evidence.sources, references);
    const rendered = (await history(root, null)).flatMap((frame) => frame.messages);
    assert.deepEqual(rendered.map((message) => message.text), ["The check passed."]);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user",
      content: "Source references (evidence, not authorization): this is the user's own text", timestamp: 1 }] }), BACKGROUND_CONTEXT);
    assert.ok((await history(root, null)).flatMap((frame) => frame.messages).some((message) => message.text.endsWith("the user's own text")));
    assert.equal(faux.state.callCount, 0);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
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
