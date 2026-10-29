import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { ConversationModels, DEFAULT_MODEL, modelFailureMessage } from "../src/models.js";
import { TaskStore } from "../src/tasks.js";
import { history } from "../src/transcript.js";
import type { ModelSelection } from "../src/generated/ModelSelection.js";
import type { WorkerHost } from "../src/generated/WorkerHost.js";
import type { WorkerRef } from "../src/generated/WorkerRef.js";

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function tools(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(tools);
  if (!object(value)) return [];
  return [value, ...Object.values(value).flatMap(tools)];
}
function send(response: ServerResponse, event: object): void { response.write("data: " + JSON.stringify(event) + "\n\n"); }
const marker = "\uE200cite\uE202turn0search0\uE201";
const raw = "A verified component. " + marker;
interface CitationPart { text: string; annotations: { type: "url_citation"; start_index: number; end_index: number; url: string; title: string }[] }
const defaultParts: CitationPart[] = [{ text: raw, annotations: [{ type: "url_citation", start_index: raw.indexOf(marker), end_index: raw.length,
  url: "https://example.com/component", title: "Component specification" }] }];
const host: WorkerHost = { host_id: null, name: "fixture", rex_server: null, coordinator: null, cwd: "/workspace/example", agent_program: "/example/agent" };
const binding: WorkerRef = { host_id: "11111111-1111-4111-8111-111111111111", session_id: "session:22222222-2222-4222-8222-222222222222",
  window_id: "window:33333333-3333-4333-8333-333333333333", block_id: "block:44444444-4444-4444-8444-444444444444" };
function complete(response: ServerResponse, id: number, parts: CitationPart[] = defaultParts, preface?: CitationPart[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const search = { id: "search_" + id, type: "web_search_call", status: "completed", action: { type: "search", queries: ["synthetic component specification"] } };
  const thinking = { id: "reasoning_" + id, type: "reasoning", summary: [{ type: "summary_text", text: "Checking the source." }], encrypted_content: "synthetic-encrypted-replay" };
  const message = { type: "message", id: "message_" + id, role: "assistant", phase: "final_answer", status: "completed",
    content: parts.map((part) => ({ type: "output_text", ...part })) };
  const leading = { ...message, id: "preface_" + id, phase: "commentary", content: (preface ?? []).map((part) => ({ type: "output_text", ...part })) };
  const writeMessage = (item: typeof message, index: number) => {
    send(response, { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", content: [] } });
    send(response, { type: "response.content_part.added", item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    send(response, { type: "response.output_text.delta", item_id: item.id, output_index: index, content_index: 0, delta: item.content.map((part) => part.text).join("") });
    send(response, { type: "response.output_item.done", output_index: index, item });
  };
  send(response, { type: "response.created", response: { id: "response_" + id, object: "response", status: "in_progress", output: [] } });
  send(response, { type: "response.output_item.added", output_index: 0, item: { ...search, status: "in_progress" } });
  send(response, { type: "response.web_search_call.searching", item_id: search.id, output_index: 0 });
  send(response, { type: "response.output_item.done", output_index: 0, item: search });
  let index = 1;
  if (preface !== undefined) writeMessage(leading, index++);
  send(response, { type: "response.output_item.added", output_index: index, item: { ...thinking, summary: [] } });
  send(response, { type: "response.output_item.done", output_index: index++, item: thinking });
  writeMessage(message, index);
  send(response, { type: "response.completed", response: { id: "response_" + id, object: "response", status: "completed", output: [search, ...(preface === undefined ? [] : [leading]), thinking, message],
    usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } } } });
  response.end();
}
async function server(handler: (response: ServerResponse, body: Record<string, unknown>, id: number) => void) {
  const requests: Record<string, unknown>[] = []; let failure: unknown;
  const server = createServer((request, response) => { void (async () => {
    const data: Buffer[] = []; for await (const chunk of request) data.push(Buffer.from(chunk));
    const bytes = Buffer.concat(data);
    const body: unknown = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"));
    assert.ok(object(body)); requests.push(body); handler(response, body, requests.length);
  })().catch((error: unknown) => { failure = error; response.writeHead(500).end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); if (failure !== undefined) throw failure; } };
}
async function open(directory: string, url: string, provider: "openai" | "openai-codex" = "openai") {
  const models = createModels(), native = provider === "openai" ? openaiProvider() : openaiCodexProvider();
  const original = native.getModels().find((model) => model.id === DEFAULT_MODEL.model_id) ?? native.getModels()[0]; assert.ok(original);
  const selection: ModelSelection = { ...DEFAULT_MODEL, provider, model_id: original.id, fast: provider === "openai" };
  const token = provider === "openai" ? "sk-synthetic" : "fixture." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64") + ".fixture";
  models.setProvider({ ...native, getModels: () => [{ ...original, baseUrl: url }],
    auth: { apiKey: { name: "Synthetic authentication", resolve: async () => ({ auth: { apiKey: token } }) } } });
  const inference = new ConversationModels(models), registry = createRegistry();
  const fixture = defineExtension({ name: "fixture", tools: [defineTool({ name: "fixture_tool", description: "An existing application tool", parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "Done" }] }) })] }); registry.install(fixture);
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))), {
    models, registry, identity: { attribution: null }, settings: { stream: { transport: "sse", maxRetries: 0 }, compaction: { enabled: false }, retry: { enabled: false } },
  }, BACKGROUND_CONTEXT);
  const tasks = new TaskStore(session, inference), root = await session.root(BACKGROUND_CONTEXT);
  await inference.configure(root, selection, { extensions: [fixture] });
  return { session, root, tasks, inference, selection, fixture };
}
async function answer(app: Awaited<ReturnType<typeof open>>): Promise<AssistantMessage> {
  const page = await app.root.entries({ order: "descending" }, 10, undefined, BACKGROUND_CONTEXT);
  const entry = page.items.find(AssistantEntry.is), message = entry?.model?.find((item) => item.role === "assistant"); assert.ok(message); return message;
}

test("native hosted search keeps existing tools, fast policy, replay data and citations through main, workers, children and SQLite reopen", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-web-search-")), wire = await server((response, _body, id) => complete(response, id));
  let app = await open(directory, wire.url);
  try {
    assert.equal((await (await app.root.submit({ type: "input", content: "Check a component source." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    const message = await answer(app), content = message.content.find((part) => part.type === "text"); assert.ok(content);
    assert.equal(content.text, "A verified component. [1](<https://example.com/component>)");
    assert.ok(content.textSignature); assert.equal(message.usage.totalTokens, 12);
    assert.ok(message.content.some((part) => part.type === "thinking" && part.thinkingSignature?.includes("synthetic-encrypted-replay")));
    const task = await app.tasks.create({ title: "Check component", outcome: "Verify the specification", model: app.selection });
    await app.tasks.enqueue(task.id, "Check a component source."); await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const bound = (await app.tasks.get(task.id)).worker; assert.equal(bound.state, "bound"); if (bound.state !== "bound") throw new Error("No task binding");
    const command = { type: "run_task", task_id: task.id, allocation_id: bound.allocation_id, binding, instructions: "", cwd: host.cwd, model: app.selection } satisfies Extract<import("../src/generated/RuntimeCommand.js").RuntimeCommand, { type: "run_task" }>;
    const worked = await app.tasks.run(command, () => () => {}, () => {}, [app.fixture]); assert.match(worked.text, /https:\/\/example.com\/component/);
    const child = await app.tasks.createAgent(task.id, { id: "source-review", title: "Review source", outcome: "Verify the source", input: "Check the source independently.", inputId: "review-input" });
    await app.tasks.dispatchAgent(task.id, child.id, async () => ({ type: "spawned", binding: { ...binding, block_id: "block:55555555-5555-4555-8555-555555555555" } }));
    const childWorker = (await app.tasks.get(task.id)).agents[0]?.worker; assert.equal(childWorker?.state, "bound"); if (childWorker?.state !== "bound") throw new Error("No child binding");
    const reviewed = await app.tasks.run({ ...command, agent_id: child.id, allocation_id: childWorker.allocation_id, binding: childWorker.binding }, () => () => {}, () => {}, [app.fixture]);
    assert.match(reviewed.text, /https:\/\/example.com\/component/); assert.equal(wire.requests.length, 3);
    for (const request of wire.requests) {
      assert.equal(request.service_tier, "priority");
      assert.ok(tools(request).some((tool) => tool.type === "web_search" && tool.external_web_access === true));
      assert.ok(tools(request).some((tool) => tool.type === "function" && tool.name === "fixture_tool"));
    }
    await app.session.close(BACKGROUND_CONTEXT); app = await open(directory, wire.url);
    assert.equal((await answer(app)).content.find((part) => part.type === "text")?.text, content.text);
    assert.equal((await answer(app)).content.find((part) => part.type === "text")?.textSignature, content.textSignature);
    const rendered = (await history(app.root, null)).flatMap((frame) => frame.messages).filter((item) => item.role === "final");
    assert.equal(rendered.length, 1); assert.equal(rendered[0]?.text, content.text); assert.equal(wire.requests.length, 3);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy Codex Responses uses its native transport and the same durable citation adapter", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-web-search-")), wire = await server((response, _body, id) => complete(response, id));
  const app = await open(directory, wire.url, "openai-codex");
  try {
    assert.equal((await (await app.root.submit({ type: "input", content: "Check the published source." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.match((await answer(app)).content.find((part) => part.type === "text")?.text ?? "", /\[1\]\(<https:\/\/example.com\/component>\)/);
    assert.ok(tools(wire.requests).some((tool) => tool.type === "web_search")); assert.equal(wire.requests.length, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native citation spans preserve ordinary text, Unicode and every source across content parts and malformed offsets", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-web-search-"));
  const parts: CitationPart[] = [
    { text: "A violet component. ", annotations: [{ type: "url_citation", start_index: 2, end_index: 8, url: "https://example.com/violet", title: "Violet" }] },
    { text: "\u{1F9F0} durable " + marker, annotations: [
      { type: "url_citation", start_index: 1, end_index: 2, url: "https://example.com/unicode", title: "An invalid split surrogate" },
      { type: "url_citation", start_index: 11, end_index: 11 + marker.length, url: "https://example.com/component", title: "Component" },
      { type: "url_citation", start_index: 9_999, end_index: 10_000, url: "https://example.com/late", title: "An out-of-bounds source" },
    ] },
    { text: " [official](https://example.com/source)", annotations: [{ type: "url_citation", start_index: 1, end_index: 38, url: "https://example.com/source", title: "Already linked" }] },
  ];
  const wire = await server((response, _body, id) => complete(response, id, parts)), app = await open(directory, wire.url);
  try {
    assert.equal((await (await app.root.submit({ type: "input", content: "Check these sources." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    const text = (await answer(app)).content.find((part) => part.type === "text")?.text;
    assert.equal(text, "A violet[1](<https://example.com/violet>) component. \u{1F9F0} durable [3](<https://example.com/component>) [2](<https://example.com/unicode>) [4](<https://example.com/late>) [official](https://example.com/source)");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native message identities keep citations distinct when commentary and final text are identical around reasoning", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-web-search-"));
  const preface = defaultParts.map((part) => ({ ...part, annotations: part.annotations.map((citation) => ({ ...citation, url: "https://example.com/early-source" })) }));
  const wire = await server((response, _body, id) => complete(response, id, defaultParts, preface)), app = await open(directory, wire.url);
  try {
    assert.equal((await (await app.root.submit({ type: "input", content: "Read both sources." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.deepEqual((await answer(app)).content.flatMap((part) => part.type === "text" ? [part.text] : []),
      ["A verified component. [1](<https://example.com/early-source>)", "A verified component. [1](<https://example.com/component>)"]);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test("public Pi callbacks keep their payload and event contracts without duplicating hosted tools", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-web-search-")), wire = await server((response, _body, id) => complete(response, id)), app = await open(directory, wire.url);
  try {
    const model = app.inference.models.getModel("openai", app.selection.model_id); assert.ok(model);
    let payloads = 0, events = 0;
    const context: Context = { messages: [{ role: "user", content: "Check this source.", timestamp: Date.now() }] };
    const result = await app.inference.models.streamSimple(model, context, {
      onPayload(payload) { payloads += 1; assert.ok(object(payload)); return { ...payload, tools: [{ type: "web_search", external_web_access: false }], tool_choice: "auto" }; },
      onProviderStreamEvent(event) { if (object(event) && event.type === "response.output_item.done") events += 1; },
    }).result();
    assert.equal(result.stopReason, "stop"); assert.equal(payloads, 1); assert.equal(events, 3);
    assert.equal(tools(wire.requests[0]).filter((tool) => tool.type === "web_search").length, 1);
    assert.equal(wire.requests[0]?.tool_choice, "auto");
    assert.ok(tools(wire.requests[0]).some((tool) => tool.type === "web_search" && tool.external_web_access === false));
    const invalid = await app.inference.models.streamSimple(model, context, { onPayload: () => null }).result();
    assert.equal(invalid.stopReason, "error"); assert.equal(wire.requests.length, 1);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test("interrupt cancels a held native search stream and the same conversation accepts a new message", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-web-search-"));
  let started = () => {}, disconnected = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; }), closed = new Promise<void>((resolve) => { disconnected = resolve; });
  const wire = await server((response, _body, id) => {
    if (id > 1) { complete(response, id); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    send(response, { type: "response.created", response: { id: "held", status: "in_progress", output: [] } });
    send(response, { type: "response.output_item.added", output_index: 0, item: { id: "held_search", type: "web_search_call", status: "in_progress", action: { type: "search", queries: ["synthetic specification"] } } });
    response.once("close", disconnected); started();
  }); const app = await open(directory, wire.url);
  try {
    const input = await app.root.submit({ type: "input", content: "Start a search." }, BACKGROUND_CONTEXT); await began;
    await app.root.abort(BACKGROUND_CONTEXT); await closed; assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "unanswered");
    await app.root.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal((await (await app.root.submit({ type: "input", content: "Try a fresh search." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(wire.requests.length, 2); assert.match((await answer(app)).content.find((part) => part.type === "text")?.text ?? "", /https:\/\/example.com\/component/);
  } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test("provider capability rejection stays visible and does not silently retry without search", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-web-search-")), wire = await server((response) => {
    response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { type: "invalid_request_error", code: "unsupported_tool", param: "tools", message: "web_search is unavailable for this model or account." } }));
  }); const app = await open(directory, wire.url);
  try {
    const input = await app.root.submit({ type: "input", content: "Search this account." }, BACKGROUND_CONTEXT);
    assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "unanswered");
    const page = await app.root.entries({ order: "descending" }, 10, undefined, BACKGROUND_CONTEXT);
    const error = page.items.find(AssistantEntry.is)?.model?.find((item) => item.role === "assistant"); assert.ok(error); assert.match(error.errorMessage ?? "", /web_search is unavailable/);
    assert.equal(wire.requests.length, 1);
    const task = await app.tasks.create({ title: "Check source", outcome: "Read the source", model: app.selection });
    await app.tasks.enqueue(task.id, "Search this account."); await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
    const worker = (await app.tasks.get(task.id)).worker; assert.equal(worker.state, "bound"); if (worker.state !== "bound") throw new Error("No worker binding");
    await assert.rejects(app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: worker.allocation_id, binding, instructions: "", cwd: host.cwd, model: app.selection },
      () => () => {}, () => {}), /The provider rejected hosted web search for this model or account/);
    assert.equal(wire.requests.length, 2, "Each actor makes one request; neither retries without search");
  } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test("subscription-sharing limits explain credit permission while retaining the original worker task", { timeout: 20_000 }, async (t) => {
  for (const transport of ["http", "stream"]) await t.test(transport, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-model-limit-"));
    const wire = await server((response) => {
      const error = { code: "subscription_sharing_usage_limit_exceeded", message: "PRIVATE_PROVIDER_DETAILS", type: "rate_limit_error" };
      if (transport === "http") {
        response.writeHead(429, { "content-type": "application/json" }); response.end(JSON.stringify({ error }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        send(response, { type: "response.failed", response: { id: "limited-response", status: "failed", error } }); response.end();
      }
    });
    let app = await open(directory, wire.url);
    const expected = 'ChatGPT plan usage reached a limit for this app. In Settings → Usage → App limits (https://chatgpt.com/settings/usage), review the app limit and enable "Allow other apps to use credits after reaching your usage limit" to use available credits. Its conversation is retained.';
    try {
      const task = await app.tasks.create({ title: "Retained review", outcome: "Finish the requested review", model: app.selection });
      await app.tasks.enqueue(task.id, "Continue this original request.");
      await app.tasks.dispatch(task.id, host, async () => ({ type: "spawned", binding }));
      const worker = (await app.tasks.get(task.id)).worker; assert.equal(worker.state, "bound"); if (worker.state !== "bound") throw new Error("No worker binding");
      await assert.rejects(app.tasks.run({ type: "run_task", task_id: task.id, allocation_id: worker.allocation_id, binding, instructions: "", cwd: host.cwd, model: app.selection },
        () => () => {}, () => {}), { message: expected });
      assert.equal(wire.requests.length, 1, "A limit must not start another billable request");
      await app.session.close(BACKGROUND_CONTEXT); app = await open(directory, wire.url);
      const retained = await app.tasks.get(task.id);
      assert.equal(retained.conversation_id, task.conversation_id); assert.equal(retained.state.state, "open");
      assert.deepEqual((await app.tasks.list()).map((item) => item.id), [task.id]);
      const conversation = await app.tasks.conversation(retained.conversation_id);
      assert.equal(await modelFailureMessage(conversation, "Generic failure"), expected);
      assert.ok((await history(conversation, null)).some((frame) => frame.messages.some((message) => message.role === "user" && message.text === "Continue this original request.")));
      const input = await app.root.submit({ type: "input", content: "Continue the main conversation." }, BACKGROUND_CONTEXT);
      assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "unanswered");
      assert.equal(await modelFailureMessage(app.root, "Generic main failure"), expected);
      assert.equal(wire.requests.length, 2);
    } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test("unrecognized provider failures remain sanitized instead of guessing a credit limit", { timeout: 15_000 }, async () => {
  for (const code of ["rate_limit_exceeded", "subscription_sharing_usage_limit_exceeded_retry", "subscription_sharing_usage_unavailable"]) {
    const directory = await mkdtemp(join(tmpdir(), "agent-model-error-")), wire = await server((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      send(response, { type: "response.failed", response: { id: "unrecognized-response", status: "failed",
        error: { code, message: "PRIVATE_PROVIDER_DETAILS usage limit credits" } } }); response.end();
    }); const app = await open(directory, wire.url);
    try {
      const input = await app.root.submit({ type: "input", content: "Check the original request." }, BACKGROUND_CONTEXT);
      assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "unanswered");
      assert.equal(await modelFailureMessage(app.root, "The model turn did not complete; its state is retained"), "The model turn did not complete; its state is retained");
      assert.equal(wire.requests.length, 1);
    } finally { await app.session.close(BACKGROUND_CONTEXT); await wire.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
