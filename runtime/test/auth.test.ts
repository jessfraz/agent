import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthError, ChatGptAuth } from "../src/auth.js";
import { errorEvent } from "../src/protocol.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ConversationModels, DEFAULT_MODEL } from "../src/models.js";

const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CLIENT = "oaiapp_synthetic";
type Defect = "none" | "signature" | "issuer" | "audience" | "nonce" | "expired";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value)); return value;
}
async function saved(directory: string) {
  const value: unknown = JSON.parse(await readFile(join(directory, "auth.json"), "utf8"));
  return record(value);
}
function authError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /synthetic-access|synthetic-refresh|provider-secret/);
    return true;
  };
}
async function issuer(directory: string) {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const badKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "synthetic-key", use: "sig", alg: "RS256" };
  const codes = new Map<string, URL>();
  const requests: URL[] = [];
  let url = new URL("http://127.0.0.1");
  let failure: unknown;
  const control: {
    defect: Defect; deny: boolean; scope: string; expiresIn: number;
    exchangeFails: boolean; refreshError: string; revocationFails: boolean;
    exchanges: number; refreshes: number; revocations: number; calls: number;
  } = {
    defect: "none",
    deny: false, scope: SCOPE, expiresIn: 3600,
    exchangeFails: false, refreshError: "", revocationFails: false,
    exchanges: 0, refreshes: 0, revocations: 0, calls: 0,
  };
  function jwt(nonce: string | null) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: control.defect === "issuer" ? "https://invalid.example" : url.href.slice(0, -1),
      aud: control.defect === "audience" ? "wrong-client" : CLIENT,
      sub: "synthetic-subject", email: "person@example.test", iat: now,
      exp: control.defect === "expired" ? now - 3600 : now + 3600,
      ...(nonce === null ? {} : { nonce: control.defect === "nonce" ? "wrong-nonce" : nonce }),
    };
    const input = Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic-key" })).toString("base64url") +
      "." + Buffer.from(JSON.stringify(claims)).toString("base64url");
    return input + "." + sign("RSA-SHA256", Buffer.from(input),
      control.defect === "signature" ? badKey.privateKey : key.privateKey).toString("base64url");
  }
  const server = createServer((request, response) => {
    control.calls += 1;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    void (async () => {
      const current = new URL(request.url ?? "/", url);
      if (current.pathname === "/.well-known/openid-configuration") {
        send(200, { issuer: url.href.slice(0, -1), authorization_endpoint: new URL("/authorize", url).href,
          token_endpoint: new URL("/token", url).href, jwks_uri: new URL("/jwks", url).href,
          revocation_endpoint: new URL("/revoke", url).href,
          response_types_supported: ["code"], subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"] });
      } else if (current.pathname === "/jwks") {
        send(200, { keys: [jwk] });
      } else if (current.pathname === "/authorize") {
        requests.push(current);
        const destination = new URL(current.searchParams.get("redirect_uri") ?? "");
        destination.searchParams.set("state", current.searchParams.get("state") ?? "");
        if (control.deny) {
          destination.searchParams.set("error", "access_denied");
          destination.searchParams.set("error_description", "provider-secret");
        } else {
          const code = randomUUID();
          codes.set(code, current);
          destination.searchParams.set("code", code);
          destination.searchParams.set("client_id", CLIENT);
        }
        response.writeHead(302, { location: destination.href }).end();
      } else if (current.pathname === "/token") {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const form = new URLSearchParams(body);
        assert.equal(form.get("client_id"), CLIENT);
        // Registration must survive a token-exchange failure.
        const registration = record(record((await saved(directory)).connection).registration);
        assert.equal(registration.clientId, CLIENT);
        const refresh = form.get("grant_type") === "refresh_token";
        let nonce: string | null = null;
        if (refresh) {
          control.refreshes++;
          if (control.refreshError) {
            send(control.refreshError === "invalid_grant" ? 400 : 503,
              { error: control.refreshError, error_description: "provider-secret" }); return;
          }
          assert.equal(form.get("refresh_token"), "synthetic-refresh-1");
        } else {
          control.exchanges++;
          const authorization = codes.get(form.get("code") ?? "");
          assert.ok(authorization);
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
          assert.equal(challenge, authorization.searchParams.get("code_challenge"));
          assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
          assert.equal(form.get("resource"), "https://api.openai.com/v1");
          nonce = authorization.searchParams.get("nonce");
          assert.ok(nonce);
          if (control.exchangeFails) { send(400, { error: "invalid_grant", error_description: "provider-secret" }); return }
        }
        send(200, { access_token: refresh ? "synthetic-access-2" : "synthetic-access-1",
          refresh_token: refresh ? "synthetic-refresh-2" : "synthetic-refresh-1",
          token_type: "Bearer", expires_in: refresh ? 3600 : control.expiresIn,
          scope: control.scope, id_token: jwt(nonce) });
      } else if (current.pathname === "/revoke") {
        control.revocations++;
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const form = new URLSearchParams(body);
        assert.equal(form.get("client_id"), CLIENT);
        assert.equal(form.get("token"), "synthetic-refresh-1");
        assert.equal(form.get("token_type_hint"), "refresh_token");
        send(control.revocationFails ? 503 : 200, control.revocationFails ? { error: "provider-secret" } : {});
      } else send(404, {});
    })().catch((error: unknown) => { failure = error; send(500, { error: "fixture_failure" }) });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  url = new URL("http://127.0.0.1:" + address.port);
  return { url, requests, control, check() { if (failure) throw failure },
    async close() { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) } };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-auth-"));
  const provider = await issuer(directory);
  const auth = new ChatGptAuth(directory, { testIssuer: provider.url, callbackPort: 0 });
  return { directory, provider, auth,
    async close() { await provider.close(); await rm(directory, { recursive: true, force: true }) } };
}
async function login(auth: ChatGptAuth) {
  let browser: Promise<Response> | undefined;
  const result = auth.login(url => { browser = fetch(url); void browser.catch(() => {}) }, new AbortController().signal);
  try { return await result } finally { await browser }
}

test("signed-out credentials return the login command before contacting the provider", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.auth.credential(), (error: unknown) => {
      assert.ok(error instanceof AuthError); assert.equal(error.code, "needs_sign_in");
      assert.deepEqual(errorEvent(error), { type: "failure", code: "authentication_required",
        message: "Not signed in to ChatGPT. Run agent login." });
      return true;
    });
    assert.equal(f.provider.control.calls, 0);
    assert.deepEqual(await f.auth.status(), { state: "signed_out" });
  } finally { await f.close() }
});

test("verified login persists one private registration and exposes only account metadata", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.auth.status(), { state: "signed_out" });
    const before = await saved(f.directory);
    const status = await login(f.auth);
    assert.equal(status.state, "connected");
    if (status.state !== "connected") assert.fail("not connected");
    assert.deepEqual(status.account, { issuer: f.provider.url.href.slice(0, -1),
      subject: "synthetic-subject", email: "person@example.test" });
    assert.ok(status.expires_at > Date.now() / 1000);
    assert.doesNotMatch(JSON.stringify(status), /synthetic-access|synthetic-refresh|idToken/);
    const credential = await f.auth.credential();
    assert.equal(credential.type, "oauth");
    assert.equal(credential.access, "synthetic-access-1");
    assert.equal(credential.clientId, CLIENT);
    assert.equal(credential.expires, status.expires_at * 1000);
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.directory, "auth.json"))).mode & 0o777, 0o600);
    assert.equal((await saved(f.directory)).hostId, before.hostId);
    const restored = new ChatGptAuth(f.directory, { testIssuer: f.provider.url, callbackPort: 0 });
    await chmod(f.directory, 0o755);
    await chmod(join(f.directory, "auth.json"), 0o644);
    assert.deepEqual(await restored.status(), status);
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.directory, "auth.json"))).mode & 0o777, 0o600);
    f.provider.check();
  } finally { await f.close() }
});

test("registration survives failed exchange and is reused after logout", async () => {
  const f = await fixture();
  try {
    f.provider.control.exchangeFails = true;
    await assert.rejects(login(f.auth), authError("exchange"));
    assert.deepEqual(await f.auth.status(), { state: "needs_sign_in", account: null });
    const installation = (await saved(f.directory)).hostId;
    f.provider.control.exchangeFails = false;
    await login(f.auth);
    await f.auth.logout();
    assert.deepEqual(await f.auth.status(), { state: "signed_out" });
    const disconnected = record((await saved(f.directory)).connection);
    assert.equal(record(disconnected.registration).idToken, null);
    assert.equal(disconnected.tokens, undefined);
    await login(f.auth);
    assert.deepEqual(f.provider.requests.map(request => request.searchParams.get("client_id")),
      ["dynamic_agent_client", CLIENT, CLIENT]);
    assert.deepEqual(f.provider.requests.map(request => request.searchParams.get("ext_agent_host_id")),
      [installation, installation, installation]);
    assert.equal(f.provider.control.revocations, 1);
    f.provider.check();
  } finally { await f.close() }
});

test("first-registration denial is permission failure without registration or tokens", async () => {
  const f = await fixture();
  try {
    f.provider.control.deny = true;
    await assert.rejects(login(f.auth), authError("permission"));
    assert.deepEqual(await f.auth.status(), { state: "signed_out" });
    assert.equal(f.provider.control.exchanges, 0);
    f.provider.check();
  } finally { await f.close() }
});

for (const defect of ["signature", "issuer", "audience", "nonce", "expired"] satisfies Defect[]) {
  test("ID-token " + defect + " failure cannot produce a connected account", async () => {
    const f = await fixture();
    try {
      f.provider.control.defect = defect;
      await assert.rejects(login(f.auth), authError("validation"));
      await assert.rejects(f.auth.credential(), authError("needs_sign_in"));
      assert.deepEqual(await f.auth.status(), { state: "needs_sign_in", account: null });
      assert.equal(record((await saved(f.directory)).connection).tokens, undefined);
      f.provider.check();
    } finally { await f.close() }
  });
}

test("missing direct-plan permission retains verified identity but never bearer credentials", async () => {
  const f = await fixture();
  try {
    f.provider.control.scope = "openid profile email";
    await assert.rejects(login(f.auth), authError("permission"));
    const status = await f.auth.status();
    assert.equal(status.state, "needs_sign_in");
    if (status.state !== "needs_sign_in") assert.fail("unexpected status");
    assert.equal(status.account?.subject, "synthetic-subject");
    assert.equal(record((await saved(f.directory)).connection).tokens, undefined);
    f.provider.check();
  } finally { await f.close() }
});

test("concurrent credential callers rotate refresh tokens once and reopen durably", async () => {
  const f = await fixture();
  try {
    f.provider.control.expiresIn = 30;
    await login(f.auth);
    const credentials = await Promise.all([f.auth.credential(), f.auth.credential(), f.auth.credential()]);
    assert.equal(f.provider.control.refreshes, 1);
    for (const credential of credentials) {
      assert.equal(credential.access, "synthetic-access-2");
      assert.equal(credential.refresh, "synthetic-refresh-2");
    }
    const restored = new ChatGptAuth(f.directory, { testIssuer: f.provider.url });
    assert.equal((await restored.credential()).refresh, "synthetic-refresh-2");
    f.provider.check();
  } finally { await f.close() }
});

test("transient refresh failure retains tokens; invalid_grant transitions to needs_sign_in", async () => {
  const f = await fixture();
  try {
    f.provider.control.expiresIn = 30;
    await login(f.auth);
    f.provider.control.refreshError = "temporarily_unavailable";
    await assert.rejects(f.auth.credential(), authError("refresh"));
    assert.equal((await f.auth.status()).state, "connected");
    assert.equal(record(record((await saved(f.directory)).connection).tokens).refresh, "synthetic-refresh-1");
    f.provider.control.refreshError = "invalid_grant";
    await assert.rejects(f.auth.credential(), (error: unknown) => {
      assert.ok(authError("needs_sign_in")(error));
      assert.ok(error instanceof AuthError);
      assert.equal(error.message, "ChatGPT sign-in expired. Run agent login.");
      return true;
    });
    assert.equal((await f.auth.status()).state, "needs_sign_in");
    assert.equal(record((await saved(f.directory)).connection).tokens, undefined);
    let environmentReads = 0;
    const inference = new ConversationModels(builtinModels({ authContext: {
      env: async () => { environmentReads += 1; return "sk-synthetic"; }, fileExists: async () => false,
    } }), f.auth);
    await assert.rejects(inference.preflight(DEFAULT_MODEL), authError("needs_sign_in"));
    assert.equal(environmentReads, 0, "A failed stored credential must not switch to an environment key");
    f.provider.check();
  } finally { await f.close() }
});

test("unrelated callback is ignored and cancellation releases its listener", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    let visit: Promise<Response> | undefined;
    let callback: URL | undefined;
    const operation = f.auth.login(url => {
      callback = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
      const unrelated = new URL(callback);
      unrelated.searchParams.set("state", "unrelated");
      unrelated.searchParams.set("code", "unrelated");
      visit = fetch(unrelated).then(response => { controller.abort(); return response });
      void visit.catch(() => {});
    }, controller.signal);
    await assert.rejects(operation, authError("cancelled"));
    assert.equal((await visit)?.status, 400);
    assert.ok(callback);
    await assert.rejects(fetch(callback));
    assert.equal(f.provider.control.exchanges, 0);
    assert.deepEqual(await f.auth.status(), { state: "signed_out" });
  } finally { await f.close() }
});

test("revocation failure clears local tokens and survives the protocol error boundary", async () => {
  const f = await fixture();
  try {
    await login(f.auth);
    f.provider.control.revocationFails = true;
    let failure: unknown;
    try { await f.auth.logout() } catch (error) { failure = error }
    assert.ok(failure instanceof AuthError);
    const event = errorEvent(failure);
    assert.equal(event.type, "failure");
    assert.equal(event.message, "Signed out locally; remote ChatGPT revocation was not confirmed.");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-access|synthetic-refresh|provider-secret/);
    assert.deepEqual(await f.auth.status(), { state: "signed_out" });
    const connection = record((await saved(f.directory)).connection);
    assert.equal(connection.tokens, undefined);
    assert.equal(record(connection.registration).idToken, null);
    f.provider.check();
  } finally { await f.close() }
});

test("malformed private state is not silently replaced by a new installation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "auth.json"), '{"version":99}', { mode: 0o600 });
    await assert.rejects(f.auth.status(), authError("storage"));
    await assert.rejects(f.auth.credential(), authError("storage"));
    assert.equal(await readFile(join(f.directory, "auth.json"), "utf8"), '{"version":99}');
    assert.equal(f.provider.control.calls, 0);
  } finally { await f.close() }
});
