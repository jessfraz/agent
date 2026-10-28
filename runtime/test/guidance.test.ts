import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { createGuidance } from "../src/guidance.js";
import type { GuidanceSnapshot } from "../src/generated/GuidanceSnapshot.js";
import type { HostCommand } from "../src/generated/HostCommand.js";
import type { HostResult } from "../src/generated/HostResult.js";
import { Executions } from "../src/tools.js";

async function snapshot(path: string): Promise<GuidanceSnapshot> {
  try {
    const text = await readFile(path, "utf8");
    return { text, sources: [{ path, sha256: createHash("sha256").update(text).digest("hex") }] };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { text: "", sources: [] };
    throw new Error("Synthetic guidance file could not be read");
  }
}

async function open() {
  const directory = await mkdtemp(join(tmpdir(), "agent-guidance-"));
  const global = join(directory, "global.md"), project = join(directory, "project.md"), shared = join(directory, "shared.md");
  const executions = new Executions(), registry = createRegistry(), models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  registry.install(createGuidance(executions));
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models, registry, identity: { attribution: null }, settings: { compaction: { enabled: false, keepRecentTokens: 0 } } }, BACKGROUND_CONTEXT);
  const root = await session.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "openai", modelId: "fixture" }, instructions: "Static task policy stays present." } });
  let sharedReads = 0, projectReads = 0;
  let nestedProject: string | undefined;
  const call = async (command: HostCommand): Promise<HostResult> => {
    assert.equal(command.type, "reload_guidance", "Working-project reads use their explicit owning-host callback");
    sharedReads += 1;
    try {
      const context = await snapshot(shared);
      return { type: "shared_guidance", global: await snapshot(global), workflow_policy: "Static application workflow stays distinct.",
        context_repositories: [{ id: "shared", root: directory, instructions: context.text }], context_sources: context.sources };
    } catch (error) { return { type: "failed", message: error instanceof Error ? error.message : "Guidance read failed" }; }
  };
  const release = executions.bind(root.id.toString(), { cwd: directory, hosts: [], call, project: async () => {
    projectReads += 1;
    try {
      const loaded = await snapshot(project);
      const nested = nestedProject === undefined ? undefined : await snapshot(nestedProject);
      return { type: "project_guidance", snapshot: nested === undefined ? loaded : {
        text: `${loaded.text}\n\n${nested.text}`, sources: [...loaded.sources, ...nested.sources],
      } };
    }
    catch { return { type: "failed", message: "Synthetic project guidance could not be read" }; }
  } });
  async function files(version: string): Promise<void> {
    await Promise.all([writeFile(global, `GLOBAL_${version}`), writeFile(project, `PROJECT_${version}`), writeFile(shared, `SHARED_${version}`)]);
  }
  async function input(text: string): Promise<void> {
    const settled = await (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
  }
  async function close(): Promise<void> {
    release(); await session.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true });
  }
  return { directory, global, project, shared, executions, registry, session, root, faux, files, input, close,
    reads: () => ({ shared: sharedReads, project: projectReads }), includeNestedProject: (path: string) => { nestedProject = path; } };
}

test("native Pi refreshes global, owning-project and shared guidance on model rounds, turns and after compaction", async () => {
  const app = await open();
  try {
    await app.files("ONE");
    let actions = 0;
    app.registry.install(defineExtension({ name: "guidance_fixture_tools", tools: [defineTool({ name: "update_guidance", description: "Update synthetic guidance files", parameters: Type.Object({}), execute: async () => {
      actions += 1; await app.files("TWO"); return { output: [{ type: "text", text: "Updated." }] };
    } })] }));
    const check = (version: string, next: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory => (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      for (const scope of ["GLOBAL", "PROJECT", "SHARED"]) assert.match(prompt, new RegExp(`${scope}_${version}`));
      for (const previous of ["ONE", "TWO", "THREE", "FOUR"]) if (previous !== version) assert.doesNotMatch(prompt, new RegExp(`(?:GLOBAL|PROJECT|SHARED)_${previous}`));
      assert.match(prompt, /Static task policy stays present/);
      assert.match(prompt, /Static application workflow stays distinct/);
      assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "update_guidance"));
      return next;
    };
    app.faux.setResponses([
      check("ONE", fauxAssistantMessage(fauxToolCall("update_guidance", {}), { stopReason: "toolUse" })),
      check("TWO", fauxAssistantMessage("Updated guidance used.")),
    ]);
    await app.input("Check the synthetic package."); assert.equal(actions, 1);
    await app.files("THREE"); app.faux.setResponses([check("THREE", fauxAssistantMessage("New-turn guidance used."))]);
    await app.input("Continue the same task.");
    app.faux.setResponses([fauxAssistantMessage("The earlier requests concerned a synthetic package.")]);
    const compacted = await app.session.waitForTask(await app.root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    assert.equal(compacted.state.outcome.status, "completed");
    if (compacted.state.outcome.status !== "completed") throw new Error("Compaction must complete");
    assert.ok(compacted.state.outcome.result.entryId !== undefined || compacted.state.outcome.result.submissionId !== undefined, "The test must perform actual native compaction");
    await app.root.waitForIdle(BACKGROUND_CONTEXT);
    await app.files("FOUR"); app.faux.setResponses([check("FOUR", fauxAssistantMessage("Post-compaction guidance used."))]);
    await app.input("Continue after compaction.");
    assert.deepEqual(app.reads(), { shared: 4, project: 4 });
  } finally { await app.close(); }
});

test("shared project guidance is included once while uncovered nested instructions remain", async () => {
  const app = await open();
  try {
    await app.files("SAME");
    await writeFile(app.project, await readFile(app.shared));
    app.faux.setResponses([(context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      assert.equal(prompt.split("SHARED_SAME").length - 1, 1);
      return fauxAssistantMessage("Shared guidance appears once.");
    }]);
    await app.input("Read shared guidance from its working repository.");
    const nested = join(app.directory, "nested.md");
    await writeFile(nested, "NESTED_PROJECT_GUIDANCE");
    app.includeNestedProject(nested);
    app.faux.setResponses([(context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      assert.match(prompt, /NESTED_PROJECT_GUIDANCE/);
      assert.equal(prompt.split("SHARED_SAME").length - 1, 2, "Keep the complete project section when a nested source is uncovered");
      return fauxAssistantMessage("Nested guidance remains available.");
    }]);
    await app.input("Read the nested project's additional guidance.");
  } finally { await app.close(); }
});

test("read failures replace stale native sections and block tools until a successful refresh", async () => {
  const app = await open();
  try {
    await app.files("OLD"); let effects = 0, failControl = false;
    app.registry.install(defineExtension({ name: "guidance_error_fixture", sections: [section("native_error_fixture", () => {
      if (failControl) throw new Error("Native swallowed-render fixture");
      return "Native stale-section control.";
    })], tools: [defineTool({ name: "effect", description: "Count a synthetic effect", parameters: Type.Object({}), execute: async () => {
      effects += 1; return { output: [{ type: "text", text: "Completed." }] };
    } })] }));
    app.faux.setResponses([fauxAssistantMessage("Initial guidance loaded.")]); await app.input("Read the current guidance.");
    await rm(app.global); await mkdir(app.global); failControl = true;
    app.faux.setResponses([
      (context) => {
        const prompt = getCurrentSystemPrompt(context.messages);
        assert.match(prompt, /Native stale-section control/, "Native Pi retains a section whose render throws");
        assert.match(prompt, /Workspace guidance is unavailable/);
        assert.doesNotMatch(prompt, /GLOBAL_OLD|PROJECT_OLD|SHARED_OLD/);
        assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "effect"), "Refreshing guidance must preserve tool definitions");
        return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Guidance access needs recovery."),
    ]);
    await app.input("Attempt the synthetic effect."); assert.equal(effects, 0);
    await rm(app.global, { recursive: true }); await app.files("NEW"); failControl = false;
    app.faux.setResponses([
      (context) => {
        const prompt = getCurrentSystemPrompt(context.messages);
        assert.match(prompt, /GLOBAL_NEW/); assert.match(prompt, /PROJECT_NEW/); assert.match(prompt, /SHARED_NEW/);
        assert.doesNotMatch(prompt, /Workspace guidance is unavailable|GLOBAL_OLD/);
        return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" });
      }, fauxAssistantMessage("Recovered guidance used."),
    ]);
    await app.input("Retry after source access is restored."); assert.equal(effects, 1);
  } finally { await app.close(); }
});
