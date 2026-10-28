import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { FeedbackStore } from "../src/feedback.js";
import { recordDelegation } from "../src/delegation.js";
import { ConversationModels } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import type { FeedbackContext } from "../src/generated/FeedbackContext.js";
import { fixtureModel } from "./model.js";

async function open(directory: string) {
  const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
  const storage = await SqliteStorage.open(database); const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }); models.setProvider(faux.provider);
  const session = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, new ConversationModels(models));
  return { session, tasks, faux, feedback: new FeedbackStore(directory, tasks) };
}
function context(): FeedbackContext {
  return { origin_host_id: "11111111-1111-4111-8111-111111111111", cwd: "/example/project", conversation_id: null,
    task_id: null, agent_id: null, model: fixtureModel, binding: null, draft: "Unsent draft 🦀", queued_inputs: ["Next correction"], client_errors: ["A tool request failed"] };
}

test("feedback keeps actual native decisions privately without running models or copying auth/tool files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-feedback-")); let app = await open(directory);
  try {
    const root = await app.session.root(BACKGROUND_CONTEXT);
    await writeFile(join(directory, "auth.json"), "AUTH_STORE_MUST_NOT_BE_READ");
    await root.submit({ type: "write", entry: { kind: "fixture", model: [
      { role: "system", content: "SYSTEM_PROMPT_MUST_NOT_BE_COPIED", timestamp: 1 },
      { role: "user", content: "The wrong conversation was chosen.", timestamp: 2 },
      fauxAssistantMessage([{ type: "thinking", thinking: "A related conversation should be checked", thinkingSignature: "HIDDEN_SIGNATURE" },
        { type: "thinking", thinking: "HIDDEN_REDACTED_STATE", redacted: true, thinkingSignature: "HIDDEN_ENCRYPTED_STATE" },
        fauxToolCall("delegate_task", { input: "Inspect the existing work", new_task: true })], { stopReason: "toolUse" }),
      { role: "toolResult", toolName: "delegate_task", toolCallId: "decision-call", content: [{ type: "text", text: "A separate task was allocated" }], isError: false, timestamp: 3 },
      fauxAssistantMessage(fauxToolCall("exec", { program: "printenv", args: ["SECRET_EXEC_ARGUMENT"] }), { stopReason: "toolUse" }),
      { role: "toolResult", toolName: "exec", toolCallId: "exec-call", content: [{ type: "text", text: "SECRET_EXEC_OUTPUT" }], isError: true, timestamp: 4 },
    ] } }, BACKGROUND_CONTEXT);
    await app.session.commit((tx) => recordDelegation(tx, root.id, { actor_conversation_id: root.id.toString(), tool_call_id: "decision-call",
      query: "Related existing work", candidates: [{ conversation_id: "older-work", task_id: null, score: 0.9 }], gaps: [], selection: { kind: "considered" } }), BACKGROUND_CONTEXT);
    const before = await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const bundle = await app.feedback.capture("Wrong task selection", context());
    assert.equal(bundle.context.conversation_id, root.id.toString()); assert.deepEqual(bundle.context.model, fixtureModel);
    assert.equal(bundle.context.draft, "Unsent draft 🦀"); assert.deepEqual(bundle.context.queued_inputs, ["Next correction"]);
    const evidence = bundle.entries.flatMap((entry) => entry.evidence);
    assert.ok(evidence.some((entry) => entry.type === "tool_call" && entry.name === "delegate_task" && entry.arguments?.includes("Inspect the existing work")));
    assert.ok(evidence.some((entry) => entry.type === "delegation" && entry.decision.candidates[0]?.conversation_id === "older-work"));
    assert.ok(evidence.some((entry) => entry.type === "message" && entry.role === "thinking" && entry.text === "A related conversation should be checked"));
    assert.ok(evidence.some((entry) => entry.type === "tool_result" && entry.name === "exec" && entry.is_error && entry.text === null && entry.omitted !== null));
    const serialized = await readFile(app.feedback.path(bundle.id), "utf8");
    for (const absent of ["AUTH_STORE_MUST_NOT_BE_READ", "SYSTEM_PROMPT_MUST_NOT_BE_COPIED", "SECRET_EXEC_ARGUMENT", "SECRET_EXEC_OUTPUT", "HIDDEN_SIGNATURE", "HIDDEN_REDACTED_STATE", "HIDDEN_ENCRYPTED_STATE"]) assert.equal(serialized.includes(absent), false);
    assert.equal((await stat(join(directory, "feedback"))).mode & 0o777, 0o700);
    assert.equal((await stat(app.feedback.path(bundle.id))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "feedback", "latest"))).mode & 0o777, 0o600);
    assert.deepEqual((await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id), before.items.map((entry) => entry.id));
    assert.equal(app.faux.state.callCount, 0); assert.deepEqual(await app.tasks.list(), []);
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory);
    assert.deepEqual(await app.feedback.read(null), bundle);
    await assert.rejects(app.feedback.read("../auth"), /Invalid feedback ID/);
    assert.equal((await readdir(join(directory, "feedback"))).some((name) => name.endsWith(".tmp")), false);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});

test("feedback bounds Unicode evidence and pending input, flags omissions, and resolves the durable task model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-feedback-")); const app = await open(directory);
  try {
    const task = await app.tasks.create({ title: "Inspect a regression", outcome: "Fix the existing task", model: fixtureModel });
    const conversation = await app.tasks.conversation(task.conversation_id);
    for (let i = 0; i < 42; i += 1) await conversation.submit({ type: "write", entry: { kind: "fixture", model: [
      { role: "user", content: "Native 🦀 evidence ".repeat(3000), timestamp: i },
    ] } }, BACKGROUND_CONTEXT);
    const input = { ...context(), task_id: task.id, queued_inputs: Array.from({ length: 20 }, () => "🦀".repeat(10_000)) };
    input.client_errors.push("api_key=fixture-secret-value");
    const bundle = await app.feedback.capture("Capture bounded evidence", input);
    assert.equal(bundle.older_entries, true); assert.equal(bundle.truncated, true);
    assert.equal(bundle.context.conversation_id, task.conversation_id); assert.deepEqual(bundle.context.model, fixtureModel);
    assert.equal(bundle.context.queued_inputs.length, 16);
    assert.equal(JSON.stringify(bundle).includes("fixture-secret-value"), false);
    assert.equal(JSON.stringify(bundle).includes("�"), false); assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < 200_000);
    await assert.rejects(app.feedback.capture("", context()), /Describe/);
    await assert.rejects(app.feedback.capture("Wrong conversation", { ...input, conversation_id: "another" }), /does not belong/);
    assert.equal(app.faux.state.callCount, 0);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); }
});
