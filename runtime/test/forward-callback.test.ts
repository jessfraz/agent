import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthError, ChatGptAuth } from "../src/auth.js";

const CLIENT = "oaiapp_forwarded_synthetic";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-forwarded-auth-"));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "forwarded-test", alg: "RS256", use: "sig" };
  let issuer = new URL("http://127.0.0.1");
  let challenge: URL | undefined;
  let exchangeCount = 0;
  const server = createServer((request, response) => {
    const send = (status: number, body: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    void (async () => {
      const path = new URL(request.url ?? "/", issuer).pathname;
      if (path === "/.well-known/openid-configuration") {
        send(200, { issuer: issuer.origin, authorization_endpoint: new URL("/authorize", issuer).href,
          token_endpoint: new URL("/token", issuer).href, jwks_uri: new URL("/jwks", issuer).href,
          response_types_supported: ["code"], subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"] });
      } else if (path === "/jwks") { send(200, { keys: [jwk] }); }
      else if (path === "/token") {
        let body = "";
        for await (const raw of request) {
          const chunk: unknown = raw;
          if (typeof chunk === "string") body += chunk;
          else if (Buffer.isBuffer(chunk)) body += chunk.toString("utf8");
        }
        const params = new URLSearchParams(body);
        assert.equal(params.get("client_id"), CLIENT);
        assert.ok(params.get("code_verifier"));
        const nonce = challenge?.searchParams.get("nonce");
        assert.equal(typeof nonce, "string");
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: issuer.origin, aud: CLIENT, sub: "forwarded-subject", nonce,
          iat: now, exp: now + 600, email: "person@example.test" };
        const input = Buffer.from(JSON.stringify({ alg: "RS256", kid: "forwarded-test" })).toString("base64url") + "." +
          Buffer.from(JSON.stringify(claims)).toString("base64url");
        const id_token = input + "." + sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url");
        exchangeCount += 1;
        send(200, { token_type: "Bearer", access_token: "synthetic-forwarded-access", refresh_token: "synthetic-forwarded-refresh",
          expires_in: 600, scope: SCOPE, id_token });
      } else { send(404, {}); }
    })().catch(() => send(500, { error: "synthetic_issuer_failure" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  issuer = new URL("http://127.0.0.1:" + address.port);
  const auth = new ChatGptAuth(directory, { testIssuer: issuer, callbackPort: 0 });
  return {
    auth,
    get exchanges() { return exchangeCount; },
    async start(signal: AbortSignal) {
      let opened: (url: URL) => void = () => {};
      const url = new Promise<URL>((resolve) => { opened = resolve; });
      const login = auth.login((value) => { challenge = new URL(value); opened(challenge); }, signal);
      const openedChallenge = await Promise.race([url, login.then(() => { throw new Error("Login completed without opening authorization"); })]);
      return { challenge: openedChallenge, login };
    },
    async close() {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function returned(challenge: URL, state: string): URL {
  const redirect = challenge.searchParams.get("redirect_uri");
  assert.ok(redirect);
  const callback = new URL(redirect);
  callback.searchParams.set("state", state);
  callback.searchParams.set("code", "synthetic-code");
  callback.searchParams.set("client_id", CLIENT);
  return callback;
}

test("forwarded callbacks use the real verified login path and ignore unrelated state/origin", async () => {
  const setup = await fixture();
  try {
    const pending = await setup.start(AbortSignal.timeout(5000));
    const state = pending.challenge.searchParams.get("state");
    assert.ok(state);
    assert.equal(setup.auth.forwardCallback(returned(pending.challenge, "wrong-state").href), false);
    const wrongOrigin = returned(pending.challenge, state);
    wrongOrigin.hostname = "foreign.example";
    assert.equal(setup.auth.forwardCallback(wrongOrigin.href), false);
    assert.equal(setup.exchanges, 0);
    assert.equal(setup.auth.forwardCallback(returned(pending.challenge, state).href), true);
    const status = await pending.login;
    assert.equal(status.state, "connected");
    assert.equal(setup.exchanges, 1);
    assert.equal((await setup.auth.credential()).access, "synthetic-forwarded-access");
    assert.equal(setup.auth.forwardCallback(returned(pending.challenge, state).href), false);
  } finally { await setup.close(); }
});

test("cancelled login clears forwarded ingress and closes its callback listener", async () => {
  const setup = await fixture();
  try {
    const controller = new AbortController();
    const pending = await setup.start(controller.signal);
    controller.abort();
    await assert.rejects(pending.login, (error: unknown) => error instanceof AuthError && error.code === "cancelled");
    const state = pending.challenge.searchParams.get("state");
    assert.ok(state);
    assert.equal(setup.auth.forwardCallback(returned(pending.challenge, state).href), false);
    const redirect = pending.challenge.searchParams.get("redirect_uri");
    assert.ok(redirect);
    const replacement = createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(Number(new URL(redirect).port), "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  } finally { await setup.close(); }
});
