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
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { history } from "../src/transcript.js";
import { validEvent } from "../src/protocol.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";

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
