import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, defineDoc, defineDocFamily, defineTask, ROOT_CONVERSATION_ID,
  type EntryId, type EntryRecord, type Harness, type NextTaskState, type Registry, type TaskId } from "@earendil-works/pi-durable";
import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { connect, type ClientHttp2Session } from "node:http2";
import { stripVTControlCharacters } from "node:util";
import type { ApnsConfig } from "./generated/ApnsConfig.js";
import type { NotificationRequest } from "./generated/NotificationRequest.js";
import type { NotificationStatus } from "./generated/NotificationStatus.js";
import type { NotificationTarget } from "./generated/NotificationTarget.js";
import { isUserNotice, transcript } from "./transcript.js";
import { TranscriptVisibility, transcriptVisible } from "./transcript_visibility.js";

type Installation = { id: string; token: string; generation: string; after: EntryId | null };
type State = { initialized: boolean; cursor: EntryId | null; installations: Installation[]; pending: { key: string; due: number }[]; active: TaskId<null> | null };
type Delivery = { installation_id: string; generation: string; conversation_id: string; entry_id: string; apns_id: string;
  state: "queued" | "attempting" | "retrying" | "accepted" | "rejected" | "uncertain" | "superseded" | "expired";
  status: number | null; attempts: number; retry_at: number | null; expires_at: number };
type Checkpoint = { phase: "deliver"; last: { key: string; state: Delivery["state"]; attempts: number } | null };
type Result = { state: "accepted" | "rejected" | "retrying" | "uncertain"; status: number | null; invalid_device: boolean };
export const NotificationState = defineDoc<State>({ kind: "agent.notifications", scope: "session", version: 1,
  initial: () => ({ initialized: false, cursor: null, installations: [], pending: [], active: null }), checkpointWhen: () => true });
export const NotificationDeliveries = defineDocFamily<{ delivery: Delivery | null }, null>({ kind: "agent.notification-delivery", scope: "session", family: true, version: 1,
  initial: () => ({ delivery: null }), checkpointWhen: () => true });
export class NotificationError extends Error {}
function terminal(): NextTaskState<Checkpoint, null> { return { status: "terminal", outcome: { status: "completed", result: null } }; }
export function notificationDeliveryKey(installation: string, entry: string): string { return createHash("sha256").update(JSON.stringify([installation, entry])).digest("hex"); }
function eligible(entry: EntryRecord): boolean {
  if (isUserNotice(entry)) return transcript(entry).some((message) => message.role === "notice" && message.text.trim().length > 0);
  return AssistantEntry.is(entry) && (entry.model?.some((message) => message.role === "assistant" && message.stopReason === "stop" &&
    message.content.some((part) => part.type === "text" && part.text.trim().length > 0)) ?? false);
}
function nativeEntryId(value: unknown): value is EntryId { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** Preview the same visible reply as history, never reasoning, tool details or
 * notice provenance. A short Unicode prefix leaves ample room in APNs' 4 KiB payload. */
function preview(entry: EntryRecord): string | undefined {
  if (!eligible(entry)) return;
  const text = stripVTControlCharacters(transcript(entry).filter((message) => message.role === "final" || message.role === "notice")
    .map((message) => message.text).join("\n"))
    .replace(/^[ \t]{0,3}(?:`{3,}|~{3,}).*$/gm, "")
    .replace(/^[ \t]{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(?<!\w)(\*{1,3}|_{1,3}|~~)(?=\S)(.*?\S)\1(?!\w)/g, "$2")
    .replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (text.length === 0) return;
  let body = "", length = 0;
  for (const character of text) {
    if (length === 320) return body.trimEnd() + "…";
    body += character; length++;
  }
  return body;
}
async function privateKey(path: string): Promise<KeyObject> {
  if (!path.startsWith("/") || (await realpath(path)).startsWith("/nix/store/")) throw new NotificationError("APNs needs a private key file outside the Nix store.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > 16_384) {
      throw new NotificationError("APNs key file must be a private, owner-only regular file.");
    }
    const buffer = Buffer.alloc(16_385); let length = 0;
    while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, null); if (read.bytesRead === 0) break; length += read.bytesRead; }
    if (length > 16_384) throw new NotificationError("APNs key file exceeds its size limit.");
    const key = createPrivateKey(buffer.subarray(0, length));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new NotificationError("APNs needs an ES256 private key.");
    return key;
  } finally { await file.close(); }
}

/** APNs acceptance is a provider receipt, not proof that a device displayed it. */
export class ApnsClient {
  private key: KeyObject | undefined;
  private jwt: { at: number; value: string } | undefined;
  private connection: ClientHttp2Session | undefined;
  private closed = false;
  constructor(private readonly config: ApnsConfig, private readonly origin = config.environment === "sandbox"
    ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com") {}
  async ready(): Promise<void> { this.key = await privateKey(this.config.key_file); }
  close(): void { this.closed = true; this.connection?.destroy(); this.connection = undefined; }
  private authorization(): string {
    const at = Math.floor(Date.now() / 1000);
    if (this.jwt !== undefined && at >= this.jwt.at && at - this.jwt.at < 3_000) return this.jwt.value;
    if (this.key === undefined) throw new NotificationError("APNs key is unavailable.");
    const unsigned = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.config.key_id })).toString("base64url") + "." +
      Buffer.from(JSON.stringify({ iss: this.config.team_id, iat: at })).toString("base64url");
    const value = unsigned + "." + sign("sha256", Buffer.from(unsigned), { key: this.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { at, value }; return value;
  }
  async send(delivery: Delivery, token: string, preview: string, signal: AbortSignal): Promise<Result> {
    const uncertain: Result = { state: "uncertain", status: null, invalid_device: false };
    if (this.closed || signal.aborted) return uncertain;
    try {
      const authorization = this.authorization();
      if (this.connection === undefined || this.connection.closed || this.connection.destroyed) {
        const connection = connect(this.origin); this.connection = connection;
        connection.on("error", () => {}); // Each owned request records its own uncertain result.
        connection.once("goaway", () => { if (this.connection === connection) this.connection = undefined; connection.close(); });
      }
      const request = this.connection.request({ ":method": "POST", ":path": "/3/device/" + token, authorization: "bearer " + authorization,
        "apns-topic": this.config.topic, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(delivery.expires_at / 1000)), "content-type": "application/json",
        "apns-id": delivery.apns_id, "apns-collapse-id": notificationDeliveryKey(delivery.installation_id, delivery.entry_id) },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      return await new Promise<Result>((resolve) => {
        let status: number | undefined, body = "", settled = false;
        const finish = (result: Result) => { if (!settled) { settled = true; resolve(result); } };
        request.on("response", (headers) => { if (typeof headers[":status"] === "number") status = headers[":status"]; });
        request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; if (Buffer.byteLength(body) > 4096) request.destroy(); });
        request.once("error", () => finish(uncertain)); request.once("close", () => finish(uncertain));
        request.once("end", () => {
          if (status === 200) { finish({ state: "accepted", status, invalid_device: false }); return; }
          if (status === undefined) { finish(uncertain); return; }
          let invalid_device = false;
          try {
            const value: unknown = JSON.parse(body);
            invalid_device = (status === 400 || status === 410) && value !== null && typeof value === "object" && "reason" in value &&
              ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(String(value.reason));
          } catch { /* A provider rejection remains a rejection without retaining its body. */ }
          finish({ state: status === 429 || (status >= 500 && status <= 599) ? "retrying" : "rejected", status, invalid_device });
        });
        const target: NotificationTarget = { conversation_id: delivery.conversation_id, entry_id: delivery.entry_id };
        request.end(JSON.stringify({ aps: { alert: { title: "Beep Boop", body: preview }, sound: "default" }, agent: target }));
      });
    } catch { return uncertain; }
  }
}

/** One durable dispatcher, with no model calls and no replay of uncertain sends. */
export class Notifications {
  private readonly task;
  private readonly client: ApnsClient | undefined;
  private configured = false;
  private stop: (() => void) | undefined;
  private serial: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly session: Harness, registry: Registry, config?: ApnsConfig, origin?: string) {
    this.client = config === undefined ? undefined : new ApnsClient(config, origin);
    this.task = defineTask<null, Checkpoint, null>({ name: "agent.notifications", version: 1, initial: () => ({ phase: "deliver", last: null }), phases: {
      deliver: async (task, runtime, context) => {
        let attempt: { key: string; delivery: Delivery; token: string; preview: string } | undefined;
        await runtime.commit(async (tx) => {
          const state = await tx.doc(NotificationState);
          // A newer ready delivery can replace a sleeping dispatcher. Its
          // retired task must never reclaim ownership when its timer wakes.
          if (state.active !== runtime.taskId) return terminal();
          if (state.pending.length === 0) { state.active = null; return terminal(); }
          const ready = state.pending.find((item) => item.due <= runtime.now());
          if (ready === undefined) {
            if (!this.configured || this.closed) { state.active = null; return terminal(); }
            return { status: "sleeping", until: state.pending.reduce((due, item) => Math.min(due, item.due), Number.POSITIVE_INFINITY), checkpoint: task.state.checkpoint };
          }
          const key = ready.key;
          const saved = await tx.doc(NotificationDeliveries, key, null), delivery = saved.delivery;
          // Losing local signing capability is not a delivery outcome. Retain
          // unsent work; a prior claimed attempt still becomes uncertain below.
          if (delivery?.state !== "attempting" && (!this.configured || this.closed)) {
            state.active = null; return terminal();
          }
          const device = state.installations.find((item) => item.id === delivery?.installation_id && item.generation === delivery.generation);
          const visible = delivery !== null && transcriptVisible(delivery.entry_id, await tx.doc(TranscriptVisibility, ROOT_CONVERSATION_ID));
          if ((delivery?.state === "queued" || delivery?.state === "retrying") && visible && device !== undefined && this.configured && !this.closed) {
            const id: unknown = Number(delivery.entry_id), entry = nativeEntryId(id) ? await tx.entry(id) : undefined;
            const body = entry?.conversationId === ROOT_CONVERSATION_ID ? preview(entry) : undefined;
            if (delivery.expires_at <= runtime.now()) delivery.state = "expired";
            else if (body !== undefined) {
              if (delivery.retry_at !== null && delivery.retry_at > runtime.now()) return {
                status: "sleeping", until: Math.min(delivery.retry_at, delivery.expires_at), checkpoint: task.state.checkpoint,
              };
              delivery.state = "attempting"; delivery.attempts += 1;
              attempt = { key, token: device.token, delivery: { ...delivery }, preview: body }; return;
            }
          }
          if (delivery?.state === "attempting") delivery.state = "uncertain";
          else if (delivery?.state === "queued" || delivery?.state === "retrying") delivery.state = "superseded";
          state.pending = state.pending.filter((item) => item.key !== key);
          return { status: "running", checkpoint: { phase: "deliver", last: { key, state: delivery?.state ?? "superseded", attempts: delivery?.attempts ?? 0 } } };
        }, context);
        if (attempt === undefined) return;
        const current = attempt, result = await this.client?.send(current.delivery, current.token, current.preview, runtime.signal);
        await runtime.commit(async (tx) => {
          const state = await tx.doc(NotificationState), saved = await tx.doc(NotificationDeliveries, current.key, null);
          if (saved.delivery?.state === "attempting") { saved.delivery.state = result?.state ?? "uncertain"; saved.delivery.status = result?.status ?? null; }
          if (saved.delivery?.state === "retrying") {
            // Apple permits delayed retries of explicit 429/5xx rejections.
            // The same durable task sleeps; unknown transport outcomes never retry.
            saved.delivery.retry_at = Math.min(saved.delivery.expires_at, runtime.now() + Math.min(3_600_000, 900_000 * 2 ** Math.min(saved.delivery.attempts - 1, 3)));
            const pending = state.pending.find((item) => item.key === current.key);
            if (pending !== undefined) pending.due = saved.delivery.retry_at;
            return { status: "running", checkpoint: { phase: "deliver", last: { key: current.key, state: "retrying", attempts: saved.delivery.attempts } } };
          }
          if (result?.invalid_device === true) state.installations = state.installations.filter((item) => item.id !== current.delivery.installation_id || item.generation !== current.delivery.generation);
          state.pending = state.pending.filter((item) => item.key !== current.key);
          if (state.pending.length > 0) return { status: "running", checkpoint: { phase: "deliver", last: {
            key: current.key, state: saved.delivery?.state ?? "uncertain", attempts: current.delivery.attempts,
          } } };
          state.active = null; return terminal();
        }, context);
      },
    }, abort: async (_task, runtime, context) => {
      await runtime.commit(async (tx) => { const state = await tx.doc(NotificationState); if (state.active === runtime.taskId) state.active = null; return terminal(); }, context);
    } });
    registry.install({ name: "notifications", tasks: [this.task] });
  }
  async start(): Promise<boolean> {
    if (this.stop !== undefined) return this.configured;
    try { await this.client?.ready(); this.configured = this.client !== undefined; }
    catch { console.error("APNs notifications are unavailable; check the coordinator's private key configuration."); }
    await this.session.root(BACKGROUND_CONTEXT);
    await this.session.commit(async (tx) => {
      const state = await tx.doc(NotificationState);
      if (state.active !== null) {
        const active = await tx.task(state.active);
        if (active === undefined || active.state.status === "terminal") state.active = null;
      }
    }, BACKGROUND_CONTEXT);
    this.stop = this.session.subscribeCommits((publication) => {
      if (publication.changes.some((change) => change.type === "entry" && change.value.conversationId === ROOT_CONVERSATION_ID)) this.schedule();
    });
    await this.reconcile();
    return this.configured;
  }
  close(): void { this.closed = true; this.stop?.(); this.stop = undefined; this.client?.close(); }
  private schedule(): void {
    this.serial = this.serial.then(() => this.reconcile()).catch(() => { if (!this.closed) console.error("Notification admission could not be saved; retained entries will be reconciled on reconnect."); });
  }
  private async reconcile(): Promise<void> {
    let more = true;
    while (more && !this.closed) {
      const retired: TaskId<null>[] = [];
      more = await this.session.commit(async (tx) => {
        const state = await tx.doc(NotificationState);
        if (!state.initialized) {
          state.cursor = (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1)).items[0]?.id ?? null;
          state.initialized = true;
        }
        const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending", ...(state.cursor === null ? {} : { minEntryId: state.cursor }) }, 51);
        const visibility = await tx.doc(TranscriptVisibility, ROOT_CONVERSATION_ID);
        for (const entry of page.items) {
          if (state.cursor !== null && entry.id <= state.cursor) continue;
          state.cursor = entry.id;
          if (this.client === undefined || !transcriptVisible(entry.id.toString(), visibility) || !eligible(entry)) continue;
          for (const device of state.installations) {
            if (device.after !== null && entry.id <= device.after) continue;
            const key = notificationDeliveryKey(device.id, entry.id.toString()), saved = await tx.doc(NotificationDeliveries, key, null);
            if (saved.delivery !== null) continue;
            saved.delivery = { installation_id: device.id, generation: device.generation, conversation_id: entry.conversationId.toString(),
              entry_id: entry.id.toString(), apns_id: randomUUID(), state: "queued", status: null, attempts: 0, retry_at: null, expires_at: Date.now() + 86_400_000 };
            state.pending.push({ key, due: 0 });
          }
        }
        if (state.pending.length > 0 && this.configured && !this.closed) {
          const previous = state.active, active = previous === null ? undefined : await tx.task(previous);
          if (previous === null || active === undefined || active.state.status === "terminal" ||
              (active.state.status === "sleeping" && state.pending.some((item) => item.due === 0))) {
            state.active = await tx.createTask(this.task, null, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
            if (previous !== null && active?.state.status === "sleeping") retired.push(previous);
          }
        }
        return page.items.length === 51;
      }, BACKGROUND_CONTEXT);
      for (const task of retired) await this.session.abortTask(task, BACKGROUND_CONTEXT);
    }
  }
  async request(request: NotificationRequest): Promise<NotificationStatus> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.installation_id)) throw new NotificationError("Notification installation_id must be a UUID.");
    const id = request.installation_id.toLocaleLowerCase();
    if (request.type === "register" && (request.token.length < 2 || request.token.length > 1024 || request.token.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(request.token))) {
      throw new NotificationError("Notification token must be an even-length hexadecimal value of at most 1024 characters.");
    }
    return this.session.commit(async (tx) => {
      const state = await tx.doc(NotificationState), device = state.installations.find((item) => item.id === id);
      if (request.type === "unregister") state.installations = state.installations.filter((item) => item.id !== id);
      if (request.type === "register" && device?.token !== request.token.toLocaleLowerCase()) {
        const after = (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1)).items[0]?.id ?? null;
        // APNs tokens identify one app/device. Reinstalling with a new local
        // installation ID transfers that token instead of duplicating alerts.
        state.installations = state.installations.filter((item) => item.id !== id && item.token !== request.token.toLocaleLowerCase());
        state.installations.push({ id, token: request.token.toLocaleLowerCase(), generation: randomUUID(), after });
      }
      return { configured: this.configured, registered: state.installations.some((item) => item.id === id) };
    }, BACKGROUND_CONTEXT);
  }
}
