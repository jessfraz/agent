import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "@earendil-works/pi-ai";

export type ModelStep = { text: string } | { tool: string; args: JsonObject };
export type ModelQueue = Record<string, ModelStep[]>;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

// Only the external provider is synthetic. Pi, application tools and the bridge
// are imported unchanged and consume actual Responses API event frames.
globalThis.fetch = async (input, options) => {
  const url = input instanceof Request ? input.url : input.toString();
  assert.equal(url, "https://api.openai.com/v1/responses", "The fixture must never contact an external service");
  assert.equal(typeof options?.body, "string");
  const body: unknown = JSON.parse(String(options?.body));
  assert.ok(object(body) && Array.isArray(body.input));
  const user: unknown = [...body.input].reverse().find((item: unknown) => object(item) && item.role === "user");
  assert.ok(object(user));
  const text = typeof user.content === "string" ? user.content : Array.isArray(user.content)
    ? user.content.flatMap((part: unknown) => object(part) && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
  const path = process.env.AGENT_TEST_MODEL_QUEUE; assert.ok(path);
  const queue: unknown = JSON.parse(readFileSync(path, "utf8")); assert.ok(object(queue));
  const key = Object.keys(queue).find((key) => text.includes(key)); assert.ok(key, `Unexpected synthetic input: ${text}`);
  const steps = queue[key]; assert.ok(Array.isArray(steps) && steps.length > 0);
  const step: unknown = steps.shift(); assert.ok(object(step));
  writeFileSync(path, JSON.stringify(queue));
  appendFileSync(path + ".requests", JSON.stringify({ key, body }) + "\n");
  const id = randomUUID();
  const item = typeof step.text === "string"
    ? { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] }
    : { id, type: "function_call", call_id: id, name: step.tool, arguments: JSON.stringify(step.args), status: "completed" };
  const response = { id: randomUUID(), object: "response", created_at: 1, model: "gpt-6.1-sol" };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : { arguments: "" }) } },
    ...(typeof step.text === "string" ? [
      { type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: step.text },
      { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text: step.text },
    ] : [
      { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: JSON.stringify(step.args) },
      { type: "response.function_call_arguments.done", item_id: id, output_index: 0, arguments: JSON.stringify(step.args) },
    ]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, status: "completed", output: [item], usage: {
      input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    } } },
  ];
  return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
};
await import("../../src/bridge.js");
