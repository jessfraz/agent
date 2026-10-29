import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";

async function readDetails(directory: string, requests: { entry_id: string; call_id: string; task_id?: string; agent_id?: string }[]): Promise<unknown[]> {
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/bridge.js", import.meta.url)), directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } });
  try {
    let output = "", errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(requests.map((request, index) => JSON.stringify({ version: 1, id: index + 1,
      command: { type: "read_tool_details", ...request } })).join("\n") + "\n");
    assert.equal(await exited, 0, errors);
    const frames: unknown[] = output.trim().split("\n").map((line: string) => JSON.parse(line));
    return requests.map((_, index) => {
      const frame = frames.find((frame) => frame !== null && typeof frame === "object" && "id" in frame && frame.id === index + 1 &&
        "event" in frame && frame.event !== null && typeof frame.event === "object" && "type" in frame.event && frame.event.type === "tool_details");
      assert.ok(frame !== null && typeof frame === "object" && "event" in frame && frame.event !== null && typeof frame.event === "object" && "details" in frame.event,
        `The read-only bridge must return tool details: ${output}`);
      return frame.event.details;
    });
  } finally { child.kill(); }
}

for (const failed of [false, true]) test(`native tool details return actual Pi input and ${failed ? "error" : "output"} after reopen`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tool-details-"));
  const models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const tools = defineExtension({ name: "details-fixture", tools: [defineTool({ name: "shell_check", description: "A synthetic command",
    parameters: Type.Object({ program: Type.String(), args: Type.Array(Type.String()) }),
    async execute(args) { return { output: [{ type: "text", text: `${args.program} ${args.args.join(" ")}\n${failed ? "error: fixture failed" : "fixture passed"}` }], isError: failed }; },
  })] }); registry.install(tools);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const call = fauxToolCall("shell_check", { program: "printf", args: ["hello world"] });
  let anchor = "", result = "";
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [tools] }, BACKGROUND_CONTEXT);
    faux.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("Finished")]);
    await (await root.submit({ type: "input", content: "Run the fixture" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const entries = (await root.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items;
    anchor = entries.find((entry) => entry.model?.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === call.id)))?.id.toString() ?? "";
    result = entries.find((entry) => entry.model?.some((message) => message.role === "toolResult" && message.toolCallId === call.id))?.id.toString() ?? "";
    assert.ok(anchor && result); assert.equal(faux.state.callCount, 2);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  try {
    const expected = { type: "available", call_id: call.id, name: "shell_check", status: failed ? "failed" : "finished",
      input: { type: "text", text: JSON.stringify(call.arguments, null, 2), truncated: false },
      output: { type: "text", text: `printf hello world\n${failed ? "error: fixture failed" : "fixture passed"}`, truncated: false } };
    assert.deepEqual(await readDetails(directory, [{ entry_id: anchor, call_id: call.id }, { entry_id: result, call_id: call.id }]), [expected, expected]);
    assert.equal(faux.state.callCount, 2, "Opening details must never execute another generation");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI tool details resolve their actual task or child while native lookups stay in main", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tool-details-scope-"));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models));
  const call = fauxToolCall("check", { program: "printf", args: ["scoped"] });
  let taskId = "", agentId = "", anchor = "", childAnchor = "";
  try {
    const task = await tasks.create({ title: "Scope fixture", outcome: "Check scoped details", model: { provider: "openai", model_id: "fixture", reasoning: null, fast: false } });
    taskId = task.id;
    const child = await tasks.createAgent(task.id, { id: "review", title: "Review scope", outcome: "Check the child", input: "Synthetic input", inputId: "scope-input" });
    agentId = child.id;
    const conversation = await tasks.conversation(task.conversation_id);
    const childConversation = await tasks.conversation(child.conversation_id);
    const entry = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [fauxAssistantMessage([call])] }), BACKGROUND_CONTEXT);
    anchor = entry.id.toString();
    const childEntry = await childConversation.commit((tx) => tx.appendEntry(childConversation.id, { kind: "pi.assistant", model: [fauxAssistantMessage([call])] }), BACKGROUND_CONTEXT);
    childAnchor = childEntry.id.toString();
  } finally { await session.close(BACKGROUND_CONTEXT); }
  try {
    const [native, task, child, wrongTask] = await readDetails(directory, [
      { entry_id: anchor, call_id: call.id },
      { entry_id: anchor, call_id: call.id, task_id: taskId },
      { entry_id: childAnchor, call_id: call.id, task_id: taskId, agent_id: agentId },
      { entry_id: childAnchor, call_id: call.id, task_id: taskId },
    ]);
    const expected = { type: "available", call_id: call.id, name: call.name, status: "running",
      input: { type: "text", text: JSON.stringify(call.arguments, null, 2), truncated: false }, output: { type: "unavailable", reason: "pending" } };
    assert.deepEqual(native, { type: "unavailable", call_id: call.id });
    assert.deepEqual(task, expected); assert.deepEqual(child, expected);
    assert.deepEqual(wrongTask, { type: "unavailable", call_id: call.id });
    assert.equal(faux.state.callCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("tool details stay scoped, bounded and explicit about missing or pending content", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tool-details-bounds-"));
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models: createModels(), registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const call = fauxToolCall("check", { command: "🦀".repeat(20_000) });
  const pending = fauxToolCall("pending", { command: "wait" }), distant = fauxToolCall("distant", { command: "old" });
  const recent = fauxToolCall("recent", { command: "still running" });
  const requests: { entry_id: string; call_id: string }[] = [];
  try {
    const root = await session.root(BACKGROUND_CONTEXT);
    const other = await session.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const foreign = await other.commit((tx) => tx.appendEntry(other.id, { kind: "pi.assistant", model: [fauxAssistantMessage([call])] }), BACKGROUND_CONTEXT);
    requests.push({ entry_id: foreign.id.toString(), call_id: call.id });
    const entry = await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([call])] }), BACKGROUND_CONTEXT);
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "x".repeat(32_767) + "🦀tail" }], isError: false, timestamp: 1 }] }), BACKGROUND_CONTEXT);
    requests.push({ entry_id: entry.id.toString(), call_id: call.id }, { entry_id: entry.id.toString(), call_id: "wrong-call" });
    const waiting = await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([pending])] }), BACKGROUND_CONTEXT);
    requests.push({ entry_id: waiting.id.toString(), call_id: pending.id });
    await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([distant])] }), BACKGROUND_CONTEXT);
    for (let index = 0; index < 128; index += 1) await root.commit((tx) => tx.appendEntry(root.id, { kind: "fixture.padding" }), BACKGROUND_CONTEXT);
    const oldResult = await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: distant.id, toolName: distant.name,
      content: [{ type: "text", text: "Retained output" }], isError: false, timestamp: 2 }] }), BACKGROUND_CONTEXT);
    requests.push({ entry_id: oldResult.id.toString(), call_id: distant.id });
    const latest = await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([recent])] }), BACKGROUND_CONTEXT);
    requests.push({ entry_id: latest.id.toString(), call_id: recent.id });
  } finally { await session.close(BACKGROUND_CONTEXT); }
  try {
    const [foreign, large, wrong, waiting, distantResult, recentResult] = await readDetails(directory, requests);
    assert.deepEqual(foreign, { type: "unavailable", call_id: call.id });
    assert.deepEqual(wrong, { type: "unavailable", call_id: "wrong-call" });
    assert.ok(large !== null && typeof large === "object" && "input" in large && "output" in large);
    for (const content of [large.input, large.output]) {
      assert.ok(content !== null && typeof content === "object" && "text" in content && typeof content.text === "string" && "truncated" in content);
      assert.equal(content.truncated, true); assert.ok(Buffer.byteLength(content.text, "utf8") <= 32_768); assert.equal(content.text.includes("�"), false);
    }
    assert.deepEqual(waiting, { type: "available", call_id: pending.id, name: pending.name, status: "running",
      input: { type: "text", text: JSON.stringify(pending.arguments, null, 2), truncated: false }, output: { type: "unavailable", reason: "lookup_limit" } });
    assert.deepEqual(distantResult, { type: "available", call_id: distant.id, name: distant.name, status: "finished",
      input: { type: "unavailable", reason: "lookup_limit" }, output: { type: "text", text: "Retained output", truncated: false } });
    assert.deepEqual(recentResult, { type: "available", call_id: recent.id, name: recent.name, status: "running",
      input: { type: "text", text: JSON.stringify(recent.arguments, null, 2), truncated: false }, output: { type: "unavailable", reason: "pending" } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
