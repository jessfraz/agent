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
import { createMainResponsePolicy, mainResponse } from "../src/main_response.js";
import { activity, history, MainResponses, UserNoticeEntry } from "../src/transcript.js";
import { annotateTranscript } from "../src/transcript_visibility.js";

test("visible commentary satisfies only inputs it follows, across pages and hidden or unrelated notices", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-main-response-boundary-"));
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  let release = () => {}, entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const tools = defineExtension({ name: "response-boundary-fixture", tools: [defineTool({ name: "held", description: "Check the requested result", parameters: Type.Object({}),
    async execute(_args, api, context) {
      // Native pagination must reach the real commentary, not mistake a tool
      // result or passive entry for a reply.
      await api.commit(async (tx) => { for (let index = 0; index < 40; index++) await tx.appendEntry(api.conversationId, { kind: "fixture.note", data: { index } }); }, context);
      entered(); await held; return { output: [{ type: "text", text: "Checked" }] };
    } })] }); registry.install(tools);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null }, settings: { steeringMode: "all" } }, BACKGROUND_CONTEXT);
  let stop: (() => Promise<void>) | undefined;
  try {
    const policy = createMainResponsePolicy(session); registry.install(policy);
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools, policy] }, BACKGROUND_CONTEXT);
    const visible: { entry_id: string; text: string }[] = [];
    stop = await activity(session, root, () => {}, (message) => { if (message.role === "commentary") visible.push(message); });
    faux.setResponses([fauxAssistantMessage([{ type: "text", text: "Checking the requested boundary without changing the saved input." }, fauxToolCall("held", {})], { stopReason: "toolUse" }), fauxAssistantMessage("")]);
    const original = await root.submit({ type: "input", requestId: "original", content: "Check the saved input boundary." }, BACKGROUND_CONTEXT);
    await started;
    const steer = await root.submit({ type: "input", requestId: "steer", content: "Also check the interrupted boundary.", whenBusy: "steer" }, BACKGROUND_CONTEXT);
    await root.submit({ type: "write", entry: { kind: UserNoticeEntry.kind, data: { task_id: null, source_conversation_id: "999", source_entry_id: "1", text: "An unrelated worker finished.", notice_origin: { job_id: "package-tracking", title: "Package tracking" } } } }, BACKGROUND_CONTEXT);
    release();
    const first = await original.wait(BACKGROUND_CONTEXT), second = await steer.wait(BACKGROUND_CONTEXT);
    assert.ok(first.type === "input" && first.status === "done" && second.type === "input" && second.status === "done");
    assert.equal(first.answer, second.answer); assert.equal(visible.length, 1);
    assert.deepEqual(await mainResponse(session, root, first.entry, first.answer), { text: "", entry_id: first.answer.toString() },
      "Existing visible commentary already answers the original input, even more than a page back");
    const response = await mainResponse(session, root, second.entry, second.answer);
    assert.ok(response.text); assert.equal(response.entry_id, first.answer.toString(), "Earlier commentary and another worker's notice do not answer steering");
    assert.deepEqual(await mainResponse(session, root, second.entry, second.answer), response, "Repeated owner settlement reuses the same durable reply");
    assert.equal((await history(root, null, session)).flatMap((event) => event.messages).filter((message) => message.entry_id === response.entry_id && message.role === "final").length, 1);
    const commentary = visible[0]; assert.ok(commentary);
    await annotateTranscript(session, root, [{ entry_id: commentary.entry_id, classification: "internal_receipt" }]);
    assert.deepEqual(await mainResponse(session, root, first.entry, first.answer), response, "Hidden commentary cannot satisfy the visible response contract");
    const entries = (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
    assert.equal(entries.filter((entry) => entry.kind === "agent.main_response").length, 0, "A repair does not append a causally late replacement entry");
    assert.equal((await session.snapshot(MainResponses, root.id, second.answer.toString(), BACKGROUND_CONTEXT))?.text, response.text); assert.equal(faux.state.callCount, 2);
  } finally { release(); await stop?.(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

for (const stopReason of ["stop", "length", "toolUse"] satisfies ("stop" | "length" | "toolUse")[]) {
  test(`a native ${stopReason} whitespace-only terminal answer retains its repaired display on reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-terminal-response-kind-")), models = createModels(), registry = createRegistry();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
    const open = async () => Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
      { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
    let session = await open();
    try {
      const policy = createMainResponsePolicy(session); registry.install(policy);
      const root = await session.root(BACKGROUND_CONTEXT); await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [policy] }, BACKGROUND_CONTEXT);
      faux.setResponses([fauxAssistantMessage(" \n ", { stopReason })]);
      const result = await (await root.submit({ type: "input", content: "Check the actual native terminal reason." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      assert.ok(result.type === "input" && result.status === "done");
      const response = await mainResponse(session, root, result.entry, result.answer); assert.ok(response.text.trim());
      await session.close(BACKGROUND_CONTEXT); session = await open();
      const rows = (await history(await session.root(BACKGROUND_CONTEXT), null, session)).flatMap((event) => event.messages).filter((row) => row.entry_id === result.answer.toString());
      assert.deepEqual(rows, [{ entry_id: response.entry_id, role: "final", text: response.text, continuation: false, final_chunk: true }]);
      assert.equal(faux.state.callCount, 1);
    } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
  });
}

test("quiet termination cannot swallow parallel native tools or their later visible answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-quiet-parallel-")), models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  try {
    const policy = createMainResponsePolicy(session), ordinary = defineExtension({ name: "quiet-parallel-fixture", tools: [defineTool({
      name: "ordinary", description: "Complete independent requested work", parameters: Type.Object({}),
      async execute() { return { output: [{ type: "text", text: "Other work completed." }] }; },
    })] }); registry.install(policy); registry.install(ordinary);
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [policy, ordinary] }, BACKGROUND_CONTEXT);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("finish_without_reply", {}), fauxToolCall("ordinary", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("The parallel work was not silently terminated."),
    ]);
    const result = await (await root.submit({ type: "input", content: "Check the actual native parallel-control boundary." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.ok(result.type === "input" && result.status === "done");
    assert.equal((await mainResponse(session, root, result.entry, result.answer)).text, "The parallel work was not silently terminated.");
    const messages = (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.flatMap((entry) => entry.model ?? []);
    const rejected = messages.filter((message) => message.role === "toolResult" && message.toolName === "finish_without_reply");
    assert.equal(rejected.length, 1); assert.ok(rejected[0]?.role === "toolResult" && rejected[0].isError);
    assert.equal(faux.state.callCount, 2);
  } finally { await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
