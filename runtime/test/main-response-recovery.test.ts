import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createMainResponsePolicy } from "../src/main_response.js";
import { history } from "../src/transcript.js";
import { protocolLines, validEvent } from "../src/protocol.js";
import type { RuntimeCommand } from "../src/generated/RuntimeCommand.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";

const diagnostic = "No written response was produced for this request; completion is not confirmed.";
for (const first of ["retry", "reconnect"]) test(`terminal native silence survives a crash before fallback and repairs on ${first}`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-terminal-silence-")), queue = join(directory, "responses.json");
  await writeFile(queue, "{}");
  const models = createModels(), faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 }); models.setProvider(faux.provider);
  const registry = createRegistry();
  const open = async () => Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  // Deliberately stop at the real native terminal commit, before any owner-side
  // fallback call. This is the crash window, not a reopen after successful repair.
  const seeded = await open(); let answer: string;
  try {
    const policy = createMainResponsePolicy(seeded); registry.install(policy);
    const root = await seeded.root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: "openai", modelId: "fixture" }, extensions: [policy] }, BACKGROUND_CONTEXT);
    faux.setResponses([fauxAssistantMessage([{ type: "thinking", thinking: "Synthetic retained reasoning is not the requested visible reply." }, { type: "text", text: "" }])]);
    const settled = await (await root.submit({ type: "input", requestId: "terminal", content: "The direct request whose owner disappeared." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.ok(settled.type === "input" && settled.status === "done"); answer = settled.answer.toString();
    assert.equal(faux.state.callCount, 1); assert.equal((await history(root, null, seeded)).flatMap((frame) => frame.messages).some((row) => row.text === diagnostic), false);
  } finally { await seeded.close(BACKGROUND_CONTEXT); }
  try {
    for (const mode of [first, first === "retry" ? "reconnect" : "retry", "reconnect"]) {
      const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./fixtures/coordinator-runtime.js", import.meta.url)), directory],
        { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "sk-synthetic-fixture", AGENT_TEST_MODEL_QUEUE: queue } });
      const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
      const frames: RuntimeEvent[] = [], changes = new Set<() => void>(); let errors = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
      const send = (command: RuntimeCommand) => child.stdin.write(JSON.stringify({ version: 1, id: 1, command }) + "\n");
      const wait = (type: RuntimeEvent["event"]["type"]) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { changes.delete(check); reject(new Error(`Missing ${type}: ${errors}`)); }, 5_000);
        const check = () => { if (frames.some((frame) => frame.event.type === type)) { clearTimeout(timer); changes.delete(check); resolve(); } };
        changes.add(check); check();
      });
      const reader = (async () => { for await (const line of protocolLines(child.stdout)) {
        const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame); for (const check of changes) check();
        assert.notEqual(frame.event.type, "host_call", "Repair must not execute tools or start another inference");
        assert.notEqual(frame.event.type, "failure", JSON.stringify(frame));
      } })(); void reader.catch(() => {});
      try {
        if (mode === "retry") { send({ type: "main_input", input_id: "terminal", input: "A retry must not replace its saved original.", mode: "steer" }); await wait("done"); }
        else { send({ type: "observe_main", input_ids: ["terminal"] }); await wait("worker_idle"); }
        const replies = frames.flatMap<{ text: string; entry_id?: string }>(({ event }) => event.type === "answer" ? [event] : event.type === "history" ? event.messages : []);
        assert.equal(new Set(replies.filter((row) => row.text === diagnostic).map((row) => row.entry_id)).size, 1,
          "A terminal retry/reconnect must repair the lost durable visible response without another model call");
        assert.ok(replies.some((row) => row.entry_id === answer && row.text === diagnostic), "The repaired reply retains the native answer identity");
        if (mode !== "retry") { send({ type: "detach_main" }); await wait("done"); }
        child.stdin.end(); assert.equal(await closed, 0, errors); await reader;
      } finally { child.kill(); await closed; await reader.catch(() => {}); }
      const reopened = await open();
      try {
        const root = await reopened.root(BACKGROUND_CONTEXT), rows = (await history(root, null, reopened)).flatMap((frame) => frame.messages);
        assert.equal(rows.filter((row) => row.entry_id === answer && row.text === diagnostic).length, 1,
          "Repeated reopen and repair must retain exactly one canonical diagnostic");
        const original = await root.commit((tx) => tx.submissionByRequest(root.id, "terminal"), BACKGROUND_CONTEXT);
        assert.ok(original?.type === "input" && original.status === "done"); assert.equal(original.answer.toString(), answer);
      } finally { await reopened.close(BACKGROUND_CONTEXT); }
    }
    await assert.rejects(readFile(queue + ".requests"), { code: "ENOENT" });
    assert.equal(faux.state.callCount, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
