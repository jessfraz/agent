import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isIPv4 } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { RuntimeRequest } from "./generated/RuntimeRequest.js";
import type { RuntimeEvent } from "./generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ApnsConfig } from "./generated/ApnsConfig.js";
import { AuthError } from "./auth.js";

const ajv = new Ajv2020({ strict: true });
ajv.addFormat("ipv4", { type: "string", validate: isIPv4 });
ajv.addFormat("int64", { type: "number", validate: (value: number) => Number.isSafeInteger(value) });
ajv.addFormat("float", { type: "number", validate: (value: number) => Number.isFinite(value) });
ajv.addFormat("double", { type: "number", validate: (value: number) => Number.isFinite(value) });
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
ajv.addFormat("uint16", {
  type: "number",
  validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff,
});
ajv.addFormat("int32", {
  type: "number",
  validate: (value: number) => Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff,
});
ajv.addFormat("uint32", {
  type: "number",
  validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff,
});
// JSON numbers cannot safely carry every u64. Reject lossy wire values.
ajv.addFormat("uint64", {
  type: "number",
  validate: (value: number) => Number.isSafeInteger(value) && value >= 0,
});

async function schema(name: string): Promise<object> {
  const value: unknown = JSON.parse(await readFile(new URL(`../../src/generated/${name}.schema.json`, import.meta.url), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid generated protocol schema");
  }
  return value;
}

export const validRequest = ajv.compile<RuntimeRequest>(await schema("request"));
export const validEvent = ajv.compile<RuntimeEvent>(await schema("event"));
export const validApnsConfig = ajv.compile<ApnsConfig>(await schema("apns"));

/** JSON frames end at LF, never Unicode line/paragraph separators inside strings. */
export async function* protocolLines(input: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8"); let parts: string[] = [];
  const finish = () => {
    const line = parts.join(""); parts = [];
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };
  for await (const chunk of input) {
    const text = decoder.write(chunk); let start = 0;
    for (let end = text.indexOf("\n", start); end >= 0; end = text.indexOf("\n", start)) {
      parts.push(text.slice(start, end)); yield finish(); start = end + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
  }
  const tail = decoder.end(); if (tail.length > 0) parts.push(tail);
  if (parts.length > 0) yield finish();
}

type HostReply = Pick<RuntimeRequest, "id" | "version"> & {
  command: Extract<RuntimeRequest["command"], { type: "host_reply" }>;
};
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Called immediately after failed validation; retain identity, never the invalid result. */
export function invalidHostReply(value: unknown, version: number): HostReply | undefined {
  if (!object(value) || typeof value.id !== "number" || value.version !== version || !object(value.command) ||
      value.command.type !== "host_reply" || typeof value.command.call_id !== "string") return undefined;
  // Schema paths and keywords describe the contract, without including payload values or dynamic property names.
  const details = (validRequest.errors ?? []).filter((error) => error.instancePath.startsWith("/command/result"))
    .sort((left, right) => right.instancePath.length - left.instancePath.length).slice(0, 3)
    .map((error) => `${error.schemaPath} (${error.keyword})`).join(", ");
  const reply: HostReply = { version, id: value.id, command: { type: "host_reply", call_id: value.command.call_id,
    result: { type: "failed", message: "Invalid host reply; schema validation failed" + (details.length === 0 ? "." : ": " + details) } } };
  return validRequest(reply) ? reply : undefined;
}

export function errorEvent(error: unknown): Extract<RuntimeEventKind, { type: "failure" }> {
  if (error instanceof AuthError) {
    return {
      type: "failure",
      code: error.code === "storage" ? "storage_unavailable"
        : error.code === "needs_sign_in" ? "authentication_required" : "authentication_failed",
      message: error.message,
    };
  }
  return { type: "failure", code: "provider_unavailable",
    message: "The operation could not complete. Its saved state is retained." };
}
