import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UserInput } from "@earendil-works/pi-durable";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { AttachmentRef } from "./generated/AttachmentRef.js";
import type { AttachmentRequest } from "./generated/AttachmentRequest.js";
import type { AttachmentResponse } from "./generated/AttachmentResponse.js";
import type { HostCall } from "./tasks.js";

import { MAX_ATTACHMENT_BYTES, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENT_NAME_BYTES } from "./generated/attachment-limits.js";
export class AttachmentError extends Error {}
const QUOTA = 512 * 1024 * 1024;
const STAGING_LIFETIME = 24 * 60 * 60 * 1000;
export function validateInput(text: string, attachments?: readonly AttachmentRef[]): void {
  if (Buffer.byteLength(text, "utf8") > 65536 || (text.trim().length === 0 && (attachments?.length ?? 0) === 0)) {
    throw new AttachmentError("Input needs text or an attachment, with text at most 65536 UTF-8 bytes");
  }
  if ((attachments?.length ?? 0) > MAX_ATTACHMENTS) throw new AttachmentError("Choose at most eight attachments");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Metadata = { attachment: AttachmentRef; retained: boolean; complete: boolean; created: number };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function decode(value: unknown): Metadata {
  if (!object(value) || !object(value.attachment)) throw new AttachmentError("Invalid attachment metadata");
  const item = value.attachment;
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.media_type !== "string" ||
      typeof item.size_bytes !== "number" || typeof item.sha256 !== "string" || typeof value.retained !== "boolean" ||
      typeof value.complete !== "boolean" || typeof value.created !== "number") throw new AttachmentError("Invalid attachment metadata");
  return { attachment: { id: item.id, name: item.name, media_type: item.media_type, size_bytes: item.size_bytes, sha256: item.sha256 },
    retained: value.retained, complete: value.complete, created: value.created };
}
function requireId(id: string): void {
  if (!UUID.test(id) || id === "00000000-0000-0000-0000-000000000000") throw new AttachmentError("Invalid attachment ID");
}
function same(left: AttachmentRef, right: AttachmentRef): boolean {
  return left.id === right.id && left.name === right.name && left.media_type === right.media_type &&
    left.size_bytes === right.size_bytes && left.sha256 === right.sha256;
}

/** Originals are immutable, bounded and private. Staged orphans expire; admitted refs follow durable history. */
export class AttachmentStore {
  private readonly directory: string;
  private serial: Promise<void> = Promise.resolve();
  private images?: Promise<ImageProcessor>;
  constructor(state: string) { this.directory = join(state, "attachments"); }
  private folder(id: string): string { requireId(id); return join(this.directory, id); }
  private async metadata(id: string): Promise<Metadata> {
    const value: unknown = JSON.parse(await readFile(join(this.folder(id), "metadata.json"), "utf8"));
    const metadata = decode(value);
    if (metadata.attachment.id !== id) throw new AttachmentError("Attachment metadata identity does not match its directory");
    return metadata;
  }
  private async save(metadata: Metadata): Promise<void> {
    const folder = this.folder(metadata.attachment.id), path = join(folder, "metadata.json"), temporary = path + ".tmp";
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(metadata)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  }
  async request(request: AttachmentRequest): Promise<AttachmentResponse> {
    const operation = this.serial.catch(() => {}).then(() => this.transfer(request));
    this.serial = operation.then(() => {}, () => {});
    return operation;
  }
  private async transfer(request: AttachmentRequest): Promise<AttachmentResponse> {
    requireId(request.id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    const folder = this.folder(request.id);
    if (request.type === "discard") {
      let metadata: Metadata;
      try { metadata = await this.metadata(request.id); } catch (error) {
        if (object(error) && error.code === "ENOENT") return { type: "discarded" }; throw error;
      }
      if (metadata.retained) throw new AttachmentError("An admitted attachment is retained with its conversation");
      await rm(folder, { recursive: true, force: true }); return { type: "discarded" };
    }
    if (request.type === "download") {
      if (request.limit <= 0 || request.limit > ATTACHMENT_CHUNK_BYTES) throw new AttachmentError("Invalid attachment read limit");
      const metadata = await this.metadata(request.id);
      if (!metadata.complete || request.offset > metadata.attachment.size_bytes) throw new AttachmentError("Attachment is not available at this offset");
      const file = await open(join(folder, "content"), "r");
      try {
        const bytes = Buffer.alloc(Math.min(request.limit, metadata.attachment.size_bytes - request.offset));
        const read = await file.read(bytes, 0, bytes.length, request.offset);
        const next = request.offset + read.bytesRead;
        return { type: "download", data_base64: bytes.subarray(0, read.bytesRead).toString("base64"),
          next_offset: next < metadata.attachment.size_bytes ? next : null };
      } finally { await file.close(); }
    }
    if (request.name.length === 0 || Buffer.byteLength(request.name) > MAX_ATTACHMENT_NAME_BYTES || /[\/\\\x00-\x1f\x7f]/.test(request.name) ||
      request.name === "." || request.name === ".." || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(request.media_type) ||
      request.media_type.length > 127 || request.size_bytes > MAX_ATTACHMENT_BYTES || request.data_base64.length > Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4) {
      throw new AttachmentError("Invalid attachment metadata or chunk size");
    }
    const bytes = Buffer.from(request.data_base64, "base64"), end = request.offset + bytes.length;
    if (bytes.length > ATTACHMENT_CHUNK_BYTES || bytes.toString("base64") !== request.data_base64 || end > request.size_bytes ||
      (request.complete && end !== request.size_bytes)) throw new AttachmentError("Invalid attachment chunk encoding or range");
    let metadata: Metadata;
    try { metadata = await this.metadata(request.id); } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error;
      if (request.offset !== 0) throw new AttachmentError("Attachment upload must start at offset zero");
      let reserved = 0;
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
        let saved: Metadata;
        try { saved = await this.metadata(entry.name); } catch (error) {
          // A crash before the first metadata rename never returned a receipt.
          if (object(error) && error.code === "ENOENT") { await rm(this.folder(entry.name), { recursive: true, force: true }); continue; }
          throw error;
        }
        if (!saved.retained && Date.now() - saved.created > STAGING_LIFETIME) await rm(this.folder(entry.name), { recursive: true });
        else reserved += saved.attachment.size_bytes + 4096;
      }
      if (reserved + request.size_bytes + 4096 > QUOTA) throw new AttachmentError("Attachment storage is full; no input was admitted");
      await mkdir(folder, { mode: 0o700 });
      metadata = { attachment: { id: request.id, name: request.name, media_type: request.media_type, size_bytes: request.size_bytes, sha256: "" },
        retained: false, complete: false, created: Date.now() };
      await writeFile(join(folder, "content"), Buffer.alloc(0), { flag: "wx", mode: 0o600 }); await this.save(metadata);
    }
    const reference = metadata.attachment;
    if (reference.name !== request.name || reference.media_type !== request.media_type || reference.size_bytes !== request.size_bytes) {
      throw new AttachmentError("Attachment identity was reused with different content");
    }
    const file = await open(join(folder, "content"), "r+");
    try {
      const current = (await file.stat()).size;
      if (request.offset > current) throw new AttachmentError("Attachment chunk is out of order");
      const existing = Math.min(current - request.offset, bytes.length);
      if (existing > 0) {
        const previous = Buffer.alloc(existing); const read = await file.read(previous, 0, existing, request.offset);
        if (read.bytesRead !== existing || !previous.equals(bytes.subarray(0, existing))) throw new AttachmentError("Attachment retry changed its bytes");
      }
      let written = existing;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, request.offset + written);
        if (result.bytesWritten === 0) throw new AttachmentError("Attachment write stopped before the chunk completed");
        written += result.bytesWritten;
      }
      await file.sync();
    } finally { await file.close(); }
    if (request.complete) {
      const content = await readFile(join(folder, "content"));
      if (content.length !== reference.size_bytes) throw new AttachmentError("Attachment size does not match its declared size");
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (metadata.complete && reference.sha256 !== sha256) throw new AttachmentError("Attachment checksum mismatch");
      metadata.attachment.sha256 = sha256; metadata.complete = true; await this.save(metadata);
    }
    return { type: "uploaded", next_offset: end, attachment: request.complete ? { ...metadata.attachment } : null };
  }
  async references(ids: readonly string[] = []): Promise<AttachmentRef[]> {
    if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw new AttachmentError("Choose at most eight distinct attachments");
    return Promise.all(ids.map(async (id) => {
      const metadata = await this.metadata(id);
      if (!metadata.complete) throw new AttachmentError("Finish uploading attachments before sending");
      return { ...metadata.attachment };
    }));
  }
  async retain(refs: readonly AttachmentRef[] = []): Promise<AttachmentRef[]> {
    const operation = this.serial.catch(() => {}).then(async () => {
      const canonical = await this.resolve(refs);
      await this.keep(canonical);
      return canonical;
    });
    this.serial = operation.then(() => {}, () => {}); return operation;
  }
  private async keep(refs: readonly AttachmentRef[]): Promise<void> {
    for (const ref of refs) { const saved = await this.metadata(ref.id); saved.retained = true; await this.save(saved); }
  }
  /** The callback checks its live owner synchronously before starting Pi submission.
   * Serialize ownership start and retention with collection. Await Pi's SQLite
   * receipt after releasing the store queue; retain bytes on uncertain failure. */
  async admit<T>(refs: readonly AttachmentRef[] | undefined, submit: () => Promise<T> | undefined): Promise<T | undefined> {
    const operation = this.serial.catch(() => {}).then(async () => {
      const canonical = await this.resolve(refs);
      const pending = submit();
      if (pending === undefined) return undefined;
      void pending.catch(() => {});
      await this.keep(canonical);
      // Release the store queue before Pi's SQLite receipt: another SQLite
      // transaction may already be waiting to retain its own attachment refs.
      return { pending };
    });
    this.serial = operation.then(() => {}, () => {});
    return (await operation)?.pending;
  }
  async resolve(refs: readonly AttachmentRef[] = []): Promise<AttachmentRef[]> {
    const canonical = await this.references(refs.map((ref) => ref.id));
    if (canonical.some((ref, index) => refs[index] === undefined || !same(ref, refs[index]))) throw new AttachmentError("Attachment receipt does not match its stored content");
    return canonical;
  }
  async materialize(ref: AttachmentRef, call: HostCall): Promise<string> {
    const bytes = await readFile(join(this.folder(ref.id), "content"));
    if (bytes.length !== ref.size_bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new AttachmentError("Attachment bytes no longer match their receipt");
    for (let offset = 0; offset <= bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
      const end = Math.min(offset + ATTACHMENT_CHUNK_BYTES, bytes.length), complete = end === bytes.length;
      const result = await call({ type: "attachment_write", attachment: ref, offset, data_base64: bytes.subarray(offset, end).toString("base64"), complete });
      if (result.type !== "attachment_written" || result.next_offset !== end) throw new AttachmentError(result.type === "failed" ? result.message : "Execution host did not confirm the attachment");
      if (complete) { if (result.path === null) throw new AttachmentError("Execution host returned no attachment path"); return result.path; }
    }
    throw new AttachmentError("Attachment transfer did not complete");
  }
  async input(text: string, refs: readonly AttachmentRef[] | undefined, call: HostCall): Promise<{ content: UserInput; entry?: { kind: string; data: { attachments: AttachmentRef[]; text: string } } }> {
    if (refs === undefined || refs.length === 0) return { content: text };
    const canonical = await this.resolve(refs), content: Exclude<UserInput, string> = [{ type: "text", text }];
    for (const ref of canonical) {
      const path = await this.materialize(ref, call);
      content.push({ type: "text", text: `Attached file ${JSON.stringify(ref.name)} (attachment ID ${ref.id}, SHA-256 ${ref.sha256}): ${JSON.stringify(path)} on this execution host. If the cache path expires, use read_attachment with this attachment ID.` });
      if (ref.media_type.startsWith("image/")) {
        this.images ??= createNodePhotonImages({ idleMs: 1000 });
        const prepared = await (await this.images).prepare(await readFile(join(this.folder(ref.id), "content")), ref.media_type, DEFAULT_IMAGE_LIMITS);
        if (prepared === undefined) {
          if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(ref.media_type)) throw new AttachmentError("This image could not be prepared for the model; convert it to PNG or JPEG");
          content.push({ type: "text", text: `The original ${ref.media_type} file is available at the attachment path above; native image conversion was unavailable. Use file tools to inspect or convert the original.` });
        } else content.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
      }
    }
    return { content, entry: { kind: "agent.input", data: { attachments: canonical, text } } };
  }
}
