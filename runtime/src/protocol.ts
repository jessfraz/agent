import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { RuntimeRequest } from "./generated/RuntimeRequest.js";
import type { RuntimeEvent } from "./generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import { AuthError } from "./auth.js";

const ajv = new Ajv2020({ strict: true });
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
