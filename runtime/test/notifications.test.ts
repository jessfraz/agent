import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, CompactionEntry, createRegistry, Harness, ROOT_CONVERSATION_ID, type EntryRecord } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ApnsConfig } from "../src/generated/ApnsConfig.js";
import type { RuntimeEvent } from "../src/generated/RuntimeEvent.js";
import { HistoryStore } from "../src/history.js";
import { DEFAULT_MODEL } from "../src/models.js";
import { ApnsClient, notificationDeliveryKey, NotificationDeliveries, Notifications, NotificationState } from "../src/notifications.js";
import { validEvent } from "../src/protocol.js";
import { history, UserNoticeEntry } from "../src/transcript.js";
import { annotateTranscript } from "../src/transcript_visibility.js";
import { FakeClock } from "./fixtures/background-runtime.js";

const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const token = "01ab".repeat(24), replacement = "cd23".repeat(24);
type Request = { headers: IncomingHttpHeaders; body: unknown; stream: ServerHttp2Stream };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function gate() {
  let resolve = () => {}, reject = (_error: Error) => {};
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function until(session: Harness, signal: AbortSignal, condition: () => Promise<boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    let running = false, again = false, finished = false;
    const cleanup = () => { finished = true; stop(); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("Notification proof did not reach its durable boundary")); };
    async function check(): Promise<void> {
      again = true; if (running || finished) return; running = true;
      try {
        while (again && !finished) { again = false; if (await condition()) { cleanup(); resolve(); } }
      } catch (error) { cleanup(); reject(error); }
      finally { running = false; }
    }
    const stop = session.subscribeCommits(() => queueMicrotask(() => { void check(); }));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); else void check();
  });
}
async function app(directory: string, config: ApnsConfig, origin: string, beforeStart?: (session: Harness) => Promise<void>, clock?: FakeClock) {
  const registry = createRegistry();
  const session = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase(join(directory, "session.sqlite"))),
    { models: createModels(), registry, identity: { attribution: null }, ...(clock === undefined ? {} : { now: clock.now, setTimer: clock.setTimer }) }, BACKGROUND_CONTEXT);
  await session.root(BACKGROUND_CONTEXT); await beforeStart?.(session);
  const notifications = new Notifications(session, registry, config, origin); await notifications.start();
  return { session, notifications };
}
async function fixture(t: TestContext, beforeStart?: (session: Harness) => Promise<void>, clock?: FakeClock) {
  const directory = await mkdtemp(join(tmpdir(), "agent-notifications-")); await chmod(directory, 0o700);
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), key = join(directory, "AuthKey.p8");
  await writeFile(key, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const config: ApnsConfig = { team_id: "TEAM000001", key_id: "KEY0000001", topic: "dev.example.Agent", key_file: key, environment: "sandbox" };
  const server = createServer(), sessions = new Set<ServerHttp2Session>(), requests: Request[] = [];
  const replies = { send: (stream: ServerHttp2Stream) => { stream.respond({ ":status": 200 }); stream.end(); } };
  server.on("session", (session) => { sessions.add(session); session.on("error", () => {}); session.once("close", () => sessions.delete(session)); });
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    let body = ""; stream.on("error", () => {});
    stream.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
    stream.once("end", () => { const value: unknown = JSON.parse(body); requests.push({ headers, body: value, stream }); replies.send(stream); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`, current = { value: await app(directory, config, origin, beforeStart, clock) };
  t.after(async () => {
    current.value.notifications.close(); await current.value.session.close(BACKGROUND_CONTEXT);
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, config, origin, keys, requests, replies, current,
    reopen: async (beforeStart?: (session: Harness) => Promise<void>) => { current.value.notifications.close(); await current.value.session.close(BACKGROUND_CONTEXT); current.value = await app(directory, config, origin, beforeStart, clock); },
  };
}
async function append(session: Harness, kind = AssistantEntry.kind, text = "Private fixture response", stopReason: "stop" | "toolUse" = "stop"): Promise<EntryRecord> {
  return session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind, model: [fauxAssistantMessage(text, { stopReason })] }), BACKGROUND_CONTEXT);
}
async function delivery(session: Harness, installation: string, entry: EntryRecord) {
  return (await session.snapshot(NotificationDeliveries, notificationDeliveryKey(installation, entry.id.toString()), BACKGROUND_CONTEXT))?.delivery;
}

test("new canonical replies and curated notices reach APNs once per device, without historical or internal alerts", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, async (session) => { await append(session, AssistantEntry.kind, "An old historical reply"); });
  let app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  await app.notifications.request({ type: "register", installation_id: second, token: replacement });
  await append(app.session, "agent.notice", "Ordinary bookkeeping stays quiet");
  await append(app.session, CompactionEntry.kind, "Compaction stays quiet");
  await new HistoryStore(app.session).import({ host_id: "fixture", thread: { id: "old-import", title: "Old assistant body", cwd: "/example",
    created_at: 1, updated_at: 1, version: "one", version_reliable: true, archived: true, forked_from_id: null, parent_thread_id: null },
    items: [{ id: "old-final", turn_id: "old", kind: "agentMessage", role: "assistant", text: "An imported reply stays quiet", version: "one", order: 0,
      timestamp_ms: 1, data: { type: "agentMessage", text: "An imported reply stays quiet", phase: "final_answer" }, assets: [] }],
    next_cursor: null, gaps: [], complete: true });
  await append(app.session, AssistantEntry.kind, "Tool progress stays quiet", "toolUse");
  await append(app.session, AssistantEntry.kind, "   ");
  await app.session.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await tx.appendEntry(child.id, { kind: AssistantEntry.kind, model: [fauxAssistantMessage("A worker reply is not a main alert")] });
  }, BACKGROUND_CONTEXT);
  const reply = await append(app.session); app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, second, reply))?.state === "accepted");
  assert.equal(f.requests.length, 2);
  const notice = await append(app.session, "agent.user_notice", "A useful curated update", "toolUse");
  await until(app.session, t.signal, async () => (await delivery(app.session, second, notice))?.state === "accepted");
  assert.equal(f.requests.length, 4);
  for (const request of f.requests) {
    const authorization = request.headers.authorization; assert.equal(typeof authorization, "string");
    assert.ok(typeof authorization === "string"); const encoded = authorization.replace(/^bearer /u, "").split("."); assert.equal(encoded.length, 3);
    const header: unknown = JSON.parse(Buffer.from(encoded[0]!, "base64url").toString()), claims: unknown = JSON.parse(Buffer.from(encoded[1]!, "base64url").toString());
    assert.deepEqual(header, { alg: "ES256", kid: f.config.key_id }); assert.ok(object(claims)); assert.equal(claims.iss, f.config.team_id);
    assert.ok(typeof claims.iat === "number" && Math.abs(claims.iat - Date.now() / 1000) < 60);
    assert.ok(verify("sha256", Buffer.from(encoded[0] + "." + encoded[1]), { key: f.keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(encoded[2]!, "base64url")));
    assert.equal(request.headers["apns-topic"], f.config.topic); assert.equal(request.headers["apns-push-type"], "alert");
    assert.ok(Number(request.headers["apns-expiration"]) > Date.now() / 1000); assert.ok(object(request.body) && object(request.body.agent));
    assert.deepEqual(request.body.aps, { alert: { title: "Beep Boop", body: request.body.agent.entry_id === reply.id.toString()
      ? "Private fixture response" : "A useful curated update" }, sound: "default" });
    assert.equal(request.body.agent.conversation_id, ROOT_CONVERSATION_ID.toString());
    assert.ok([reply.id.toString(), notice.id.toString()].includes(String(request.body.agent.entry_id)));
  }
  assert.equal(new Set(f.requests.map((request) => request.headers.authorization)).size, 1, "Reuse the token rather than rotating it per delivery");
  assert.equal(new Set(f.requests.map((request) => request.headers["apns-id"])).size, 4);
  await history(await app.session.root(BACKGROUND_CONTEXT), null, app.session); await app.notifications.start();
  await f.reopen(); app = f.current.value; app.session.resume();
  assert.equal((await delivery(app.session, first, reply))?.state, "accepted"); assert.equal(f.requests.length, 4);
  const sameText = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, second, sameText))?.state === "accepted");
  assert.equal(f.requests.length, 6, "Distinct replies with identical text remain separate notifications");
  assert.equal((await app.session.snapshot(NotificationState, BACKGROUND_CONTEXT))?.pending.length, 0);
});

test("APNs previews contain readable bounded reply or explicit notice text, never internal blocks", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t), app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  const text = "## Ready\n\n**Board update:** [review files](https://example.com/review)\n- `R2` is ready.\n\n" + "🦀 ".repeat(2_000);
  const reply = await app.session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: AssistantEntry.kind,
    model: [{ ...fauxAssistantMessage(text), content: [
      { type: "thinking", thinking: "INTERNAL_REASONING_STAYS_PRIVATE" }, { type: "text", text },
    ] }] }), BACKGROUND_CONTEXT);
  app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, first, reply))?.state === "accepted");
  const request = f.requests[0]; assert.ok(request && object(request.body) && object(request.body.aps) && object(request.body.aps.alert));
  const body = request.body.aps.alert.body; assert.equal(typeof body, "string"); assert.ok(typeof body === "string");
  assert.ok(body.startsWith("Ready Board update: review files R2 is ready. 🦀 "), body);
  assert.ok(body.endsWith("…")); assert.ok(Array.from(body).length <= 321);
  assert.ok(!body.includes("\ufffd")); assert.equal(body.includes("INTERNAL_REASONING"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(request.body)) < 4096, "The actual JSON request must fit Apple's alert payload limit");
  const notice = await app.session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: UserNoticeEntry.kind,
    data: { task_id: null, source_conversation_id: "synthetic-source", source_entry_id: "synthetic-entry", text: "The **drawing** needs your review." },
    model: [fauxAssistantMessage("INTERNAL_CONTEXT_STAYS_PRIVATE")] }), BACKGROUND_CONTEXT);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, notice))?.state === "accepted");
  const sent = f.requests[1]; assert.ok(sent && object(sent.body));
  assert.deepEqual(sent.body.aps, { alert: { title: "Beep Boop", body: "The drawing needs your review." }, sound: "default" });
  assert.equal(JSON.stringify(sent.body).includes("INTERNAL_CONTEXT"), false);
  assert.deepEqual(sent.body.agent, { conversation_id: "1", entry_id: notice.id.toString() });
});

test("restart preserves an uncertain attempt without resending; a rejected token is retired and explicit registration recovers", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); let app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  let receivedRequest = () => {};
  const receivedBody = new Promise<void>((resolve) => { receivedRequest = resolve; });
  f.replies.send = () => receivedRequest(); const reply = await append(app.session); app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, first, reply))?.state === "attempting");
  await receivedBody;
  // Closing the native invocation after the durable attempt marker leaves the
  // provider outcome unknown, even if no receipt reached this process.
  await app.session.close(BACKGROUND_CONTEXT); app.notifications.close();
  await f.reopen(); app = f.current.value; app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, first, reply))?.state === "uncertain");
  const received = f.requests.length;
  f.replies.send = (stream) => { stream.respond({ ":status": 410 }); stream.end(JSON.stringify({ reason: "Unregistered" })); };
  const invalid = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, invalid))?.state === "rejected");
  assert.equal(f.requests.length, received + 1, "The prior uncertain delivery must not be retried");
  assert.deepEqual(await app.notifications.request({ type: "status", installation_id: first }), { configured: true, registered: false });
  await app.notifications.request({ type: "register", installation_id: first, token: replacement });
  f.replies.send = (stream) => { stream.respond({ ":status": 200 }); stream.end(); };
  const fresh = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, fresh))?.state === "accepted");
  assert.equal(f.requests.length, received + 2); assert.equal(f.requests.at(-1)?.headers[":path"], "/3/device/" + replacement);
  assert.equal((await delivery(app.session, first, reply))?.state, "uncertain");
});

test("token refresh and unregister invalidate queued generations before the native dispatcher starts", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t), app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  await app.notifications.request({ type: "register", installation_id: second, token: replacement });
  const old = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, second, old))?.state === "queued");
  const refreshed = "ef45".repeat(24);
  await app.notifications.request({ type: "register", installation_id: first, token: refreshed });
  await app.notifications.request({ type: "unregister", installation_id: second }); app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, second, old))?.state === "superseded");
  assert.equal((await delivery(app.session, first, old))?.state, "superseded"); assert.equal(f.requests.length, 0);
  const fresh = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, fresh))?.state === "accepted");
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0]?.headers[":path"], "/3/device/" + refreshed);
  await assert.rejects(app.notifications.request({ type: "register", installation_id: first, token: "not-hex" }));
  await assert.rejects(app.notifications.request({ type: "status", installation_id: "unknown" }));
});

test("APNs key loading rejects shared permissions and symlink credentials before network use", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); await chmod(f.config.key_file, 0o644);
  const shared = new ApnsClient(f.config); await assert.rejects(shared.ready()); shared.close();
  await chmod(f.config.key_file, 0o600); const link = join(f.directory, "linked.p8"); await symlink(f.config.key_file, link);
  const linked = new ApnsClient({ ...f.config, key_file: link }); await assert.rejects(linked.ready()); linked.close();
  assert.equal(f.requests.length, 0);
});

for (const initial of ["queued", "retrying"]) test(`a ${initial} delivery survives unavailable credentials and resumes without losing newer work`, { timeout: 10_000 }, async (t) => {
  const clock = new FakeClock(Date.now()), f = await fixture(t, undefined, clock);
  let app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  if (initial === "retrying") f.replies.send = (stream) => { stream.respond({ ":status": 503 }); stream.end(); };
  const retained = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, retained))?.state === "queued");
  if (initial === "retrying") {
    app.session.resume();
    await until(app.session, t.signal, async () => (await delivery(app.session, first, retained))?.state === "retrying");
  }
  await chmod(f.config.key_file, 0o644);
  await f.reopen(); app = f.current.value;
  assert.deepEqual(await app.notifications.request({ type: "status", installation_id: first }), { configured: false, registered: true });
  app.session.resume();
  if (initial === "retrying") clock.advance(15 * 60_000);
  await until(app.session, t.signal, async () => (await app.session.snapshot(NotificationState, BACKGROUND_CONTEXT))?.active === null);
  assert.equal((await delivery(app.session, first, retained))?.state, initial,
    "An unavailable local credential is not delivery supersession or a provider receipt");
  const newer = await append(app.session);
  await until(app.session, t.signal, async () => (await app.session.snapshot(NotificationState, BACKGROUND_CONTEXT))?.cursor === newer.id);
  assert.equal((await delivery(app.session, first, newer))?.state, "queued", "Opted-in devices retain new work during a credential outage");
  assert.equal((await app.session.snapshot(NotificationState, BACKGROUND_CONTEXT))?.active, null);
  await chmod(f.config.key_file, 0o600);
  f.replies.send = (stream) => { stream.respond({ ":status": 200 }); stream.end(); };
  await f.reopen(); app = f.current.value; app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, first, retained))?.state === "accepted" &&
    (await delivery(app.session, first, newer))?.state === "accepted");
  assert.equal(f.requests.length, initial === "retrying" ? 3 : 2);
});

test("a named-pipe credential is rejected without waiting for a writer or blocking coordinator startup", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-apns-fifo-")), fifo = join(directory, "AuthKey.p8");
  await chmod(directory, 0o700); execFileSync("mkfifo", [fifo]); await chmod(fifo, 0o600);
  const program = `const { ApnsClient } = await import(process.argv[1]);
process.stdout.write("loaded\\n");
const client = new ApnsClient({ team_id: "TEAM000001", key_id: "KEY0000001", topic: "dev.example.Agent", environment: "sandbox", key_file: process.argv[2] });
try { await client.ready(); process.exitCode = 2; }
catch { process.stdout.write("rejected\\n"); }
finally { client.close(); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program,
    new URL("../src/notifications.js", import.meta.url).href, fifo], { stdio: ["ignore", "pipe", "pipe"], signal: t.signal });
  let output = ""; child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const failed = new Promise<never>((_resolve, reject) => { child.once("error", reject); });
  t.after(async () => { child.kill("SIGKILL"); await closed; await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await Promise.race([closed, failed]), { code: 0, signal: null }); assert.equal(output, "loaded\nrejected\n");
});

test("known APNs rejection sleeps durably before retrying the same notification and expires bounded offline work", { timeout: 10_000 }, async (t) => {
  const clock = new FakeClock(Date.now()), f = await fixture(t, undefined, clock), app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  f.replies.send = (stream) => { stream.respond({ ":status": f.requests.length === 1 ? 503 : 200 }); stream.end(JSON.stringify({ reason: "ServiceUnavailable" })); };
  const entry = await append(app.session); app.session.resume();
  await until(app.session, t.signal, async () => {
    const saved = await delivery(app.session, first, entry); return saved !== undefined && saved !== null && saved.state !== "queued" && saved.state !== "attempting";
  });
  assert.equal((await delivery(app.session, first, entry))?.state, "retrying", "A definite temporary provider rejection must not discard the notification");
  await until(app.session, t.signal, async () => {
    const state = await app.session.snapshot(NotificationState, BACKGROUND_CONTEXT);
    return state?.active !== null && state?.active !== undefined &&
      (await app.session.commit((tx) => tx.task(state.active!), BACKGROUND_CONTEXT))?.state.status === "sleeping";
  });
  const state = await app.session.snapshot(NotificationState, BACKGROUND_CONTEXT); assert.ok(state?.active !== null && state?.active !== undefined);
  const task = await app.session.commit((tx) => tx.task(state.active!), BACKGROUND_CONTEXT);
  assert.ok(task?.state.status === "sleeping"); assert.equal(task.state.until, clock.value + 15 * 60_000);
  await app.notifications.request({ type: "register", installation_id: second, token: replacement });
  const newer = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, second, newer)) !== undefined);
  const queued = await delivery(app.session, second, newer), active = await app.session.snapshot(NotificationState, BACKGROUND_CONTEXT);
  assert.ok(active?.active !== null && active?.active !== undefined);
  const current = await app.session.commit((tx) => tx.task(active.active!), BACKGROUND_CONTEXT);
  assert.ok(queued?.state === "accepted" || current?.state.status !== "sleeping" || current.state.until <= clock.value,
    "A new queued reply must wake the dispatcher rather than wait behind another delivery's rejection");
  await until(app.session, t.signal, async () => (await delivery(app.session, second, newer))?.state === "accepted");
  assert.equal(f.requests.length, 3, "Both current devices receive the newer reply before the old retry deadline");
  await f.reopen(); const recovered = f.current.value; recovered.session.resume();
  clock.advance(15 * 60_000 - 1); assert.equal(f.requests.length, 3);
  clock.advance(1);
  await until(recovered.session, t.signal, async () => (await delivery(recovered.session, first, entry))?.state === "accepted");
  assert.equal(f.requests.length, 4); assert.equal(f.requests[0]?.headers["apns-id"], f.requests[3]?.headers["apns-id"]);
  assert.equal(f.requests[0]?.headers["apns-collapse-id"], f.requests[3]?.headers["apns-collapse-id"]);
  const expiration = Number(f.requests[0]?.headers["apns-expiration"]);
  assert.ok(expiration > Date.now() / 1000 + 23 * 3_600 && expiration <= Date.now() / 1000 + 24 * 3_600);
  assert.equal(f.requests[0]?.headers["apns-expiration"], f.requests[3]?.headers["apns-expiration"]);
  await recovered.notifications.request({ type: "unregister", installation_id: second });
  f.replies.send = (stream) => { stream.respond({ ":status": 429 }); stream.end(JSON.stringify({ reason: "TooManyRequests" })); };
  const limited = await append(recovered.session);
  await until(recovered.session, t.signal, async () => {
    const saved = await delivery(recovered.session, first, limited); return saved !== undefined && saved !== null && saved.state !== "queued" && saved.state !== "attempting";
  });
  assert.equal((await delivery(recovered.session, first, limited))?.state, "retrying");
  clock.advance(24 * 3_600_000 + 60_000);
  await until(recovered.session, t.signal, async () => (await recovered.session.snapshot(NotificationState, BACKGROUND_CONTEXT))?.active === null);
  assert.equal((await delivery(recovered.session, first, limited))?.state, "expired"); assert.equal(f.requests.length, 5);
});

test("a retained device token has one installation owner after reinstall", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t), app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  await app.notifications.request({ type: "register", installation_id: second, token });
  const entry = await append(app.session); app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, second, entry))?.state === "accepted");
  assert.equal(f.requests.length, 1, "Two installation IDs with the same native token must not send twice to one app");
  assert.deepEqual(await app.notifications.request({ type: "status", installation_id: first }), { configured: true, registered: false });
});

test("the actual coordinator bridge resumes a configured outbox without another chat or background request", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t), app = f.current.value;
  await app.notifications.request({ type: "register", installation_id: first, token });
  const entry = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, entry))?.state === "queued");
  app.notifications.close(); await app.session.close(BACKGROUND_CONTEXT);
  const preload = join(f.directory, "local-apns.mjs");
  // Redirect only Apple's transport boundary in this owned child. The bridge,
  // native task recovery, signing and HTTP/2 producer run unchanged.
  await writeFile(preload, `import http2 from "node:http2";
import { syncBuiltinESMExports } from "node:module";
const original = http2.connect;
http2.connect = (authority, ...options) => {
  if (String(authority) !== "https://api.sandbox.push.apple.com") throw new Error("Unexpected APNs authority");
  return original(process.env.AGENT_TEST_APNS_ORIGIN, ...options);
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  const done = gate(), delivered = gate();
  f.replies.send = (stream) => { stream.respond({ ":status": 200 }); stream.end(); delivered.resolve(); };
  const child = spawn(process.execPath, ["--no-warnings", "--import", preload, fileURLToPath(new URL("../src/bridge.js", import.meta.url)), f.directory],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "", AGENT_APNS_CONFIG: JSON.stringify(f.config), AGENT_TEST_APNS_ORIGIN: f.origin } });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve())), lines = createInterface({ input: child.stdout });
  const frames: RuntimeEvent[] = []; let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  const abort = () => { const error = new Error("Configured coordinator did not resume notification delivery: " + errors); done.reject(error); delivered.reject(error); };
  t.signal.addEventListener("abort", abort, { once: true }); child.once("close", abort);
  lines.on("line", (line) => {
    const frame: unknown = JSON.parse(line); assert.ok(validEvent(frame)); frames.push(frame);
    if (frame.event.type === "failure") { const error = new Error(frame.event.message); done.reject(error); delivered.reject(error); }
    else if (frame.id === 1 && frame.event.type === "done") done.resolve();
  });
  try {
    child.stdin.write(JSON.stringify({ version: 1, id: 1, command: { type: "configure_coordinator", bootstrap: { node: null,
      settings: { model: DEFAULT_MODEL, instructions: "", context_repositories: [], sources: [] } } } }) + "\n");
    await Promise.all([done.promise, delivered.promise]);
    assert.equal(f.requests.length, 1); assert.ok(object(f.requests[0]?.body));
    assert.deepEqual(f.requests[0].body.agent, { conversation_id: ROOT_CONVERSATION_ID.toString(), entry_id: entry.id.toString() });
    assert.equal(frames.some((frame) => ["host_call", "answer", "input_accepted"].includes(frame.event.type)), false,
      "Notification recovery must not ask a model, admit input or allocate a Rex worker");
  } finally {
    t.signal.removeEventListener("abort", abort); child.off("close", abort); lines.close(); child.kill("SIGKILL"); await closed;
  }
});

test("native presentation annotations suppress unseen and already queued entries without rewriting history", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); await f.current.value.notifications.request({ type: "register", installation_id: first, token });
  let hidden: EntryRecord | undefined;
  await f.reopen(async (session) => {
    hidden = await append(session);
    await annotateTranscript(session, await session.root(BACKGROUND_CONTEXT), [{ entry_id: hidden.id.toString(), classification: "internal_receipt" }]);
  });
  const app = f.current.value; assert.ok(hidden);
  assert.equal(await delivery(app.session, first, hidden), undefined, "Hidden committed entries must not enter the outbox during restart reconciliation");
  const queued = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, queued))?.state === "queued");
  await annotateTranscript(app.session, await app.session.root(BACKGROUND_CONTEXT), [{ entry_id: queued.id.toString(), classification: "maintenance_control" }]);
  app.session.resume();
  await until(app.session, t.signal, async () => (await delivery(app.session, first, queued))?.state === "superseded");
  assert.equal(f.requests.length, 0, "Queued entries must recheck authoritative visibility before the external effect");
  await annotateTranscript(app.session, await app.session.root(BACKGROUND_CONTEXT), [{ entry_id: queued.id.toString(), classification: "visible" }]);
  const fresh = await append(app.session);
  await until(app.session, t.signal, async () => (await delivery(app.session, first, fresh))?.state === "accepted");
  assert.equal(f.requests.length, 1, "Restoring an old row must not replay its alert");
});
