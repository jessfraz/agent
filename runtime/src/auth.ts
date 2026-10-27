import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import * as oidc from "openid-client";
import type { AccountIdentity } from "./generated/AccountIdentity.js";
import type { AuthStatus } from "./generated/AuthStatus.js";

const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = "openid profile email offline_access resource.invoke " + PLAN_SCOPE;

export type AuthErrorCode =
  | "storage" | "cancelled" | "registration" | "validation" | "permission"
  | "discovery" | "exchange" | "refresh" | "needs_sign_in" | "revocation";
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
  }
}
interface Registration {
  clientId: string;
  account: AccountIdentity | null;
  idToken: string | null;
}
interface Tokens { access: string; refresh: string; expiresAt: number; scopes: string[] }
type Connection =
  | { state: "signed_out"; registration: Registration | null }
  | { state: "needs_sign_in"; registration: Registration }
  | { state: "connected"; registration: Registration & { account: AccountIdentity }; tokens: Tokens };
interface SavedAuth { version: 1; hostId: string; connection: Connection }
/** Only local fake issuers are configurable; production always uses OpenAI. */
export interface AuthOptions { testIssuer?: URL; callbackPort?: number }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new AuthError("storage", "Invalid private authentication state.");
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthError("storage", "Invalid private authentication state.");
  }
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value) }
function identity(value: unknown): AccountIdentity {
  const data = object(value);
  return { issuer: text(data.issuer), subject: text(data.subject), email: nullableText(data.email) };
}
function registration(value: unknown): Registration {
  const data = object(value);
  return {
    clientId: text(data.clientId),
    account: data.account === null ? null : identity(data.account),
    idToken: nullableText(data.idToken),
  };
}
function readState(value: unknown): SavedAuth {
  const data = object(value);
  const hostId = text(data.hostId);
  if (data.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(hostId)) {
    throw new AuthError("storage", "Unsupported private authentication state.");
  }
  const connection = object(data.connection);
  if (connection.state === "signed_out") return {
    version: 1, hostId,
    connection: { state: "signed_out", registration: connection.registration === null ? null : registration(connection.registration) },
  };
  const selected = registration(connection.registration);
  if (connection.state === "needs_sign_in") return { version: 1, hostId, connection: { state: "needs_sign_in", registration: selected } };
  if (connection.state !== "connected" || selected.account === null) {
    throw new AuthError("storage", "Invalid private authentication state.");
  }
  const token = object(connection.tokens);
  if (typeof token.expiresAt !== "number" || !Number.isSafeInteger(token.expiresAt) ||
      token.expiresAt <= 0 || !Array.isArray(token.scopes)) {
    throw new AuthError("storage", "Invalid private authentication state.");
  }
  const scopes = token.scopes.map((scope: unknown) => text(scope));
  if (!scopes.includes(PLAN_SCOPE)) throw new AuthError("storage", "Saved ChatGPT plan permission is missing.");
  return { version: 1, hostId, connection: {
    state: "connected", registration: { ...selected, account: selected.account },
    tokens: { access: text(token.access), refresh: text(token.refresh), expiresAt: token.expiresAt, scopes },
  } };
}
function statusOf(connection: Connection): AuthStatus {
  switch (connection.state) {
    case "signed_out": return { state: "signed_out" };
    case "needs_sign_in": return { state: "needs_sign_in", account: connection.registration.account };
    case "connected": return { state: "connected", account: connection.registration.account, expires_at: connection.tokens.expiresAt };
  }
}
function sameAccount(left: AccountIdentity, right: AccountIdentity): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}
function safeFailure(error: unknown, code: AuthErrorCode, message: string): AuthError {
  if (error instanceof AuthError) return error;
  if (error instanceof oidc.AuthorizationResponseError && error.error === "access_denied") {
    return new AuthError("permission", "ChatGPT authorization was declined.");
  }
  if (error instanceof oidc.ClientError && [
    "OAUTH_INVALID_RESPONSE", "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
    "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED",
  ].includes(error.code ?? "")) {
    return new AuthError("validation", "The ChatGPT response failed OAuth identity validation.");
  }
  return new AuthError(code, message);
}
function requestFetch(signal?: AbortSignal, beforeToken?: () => Promise<void>, tokenUrl?: string): oidc.CustomFetch {
  return async (url, options) => {
    if (url === tokenUrl) await beforeToken?.();
    const { body, ...init } = options;
    return fetch(url, { ...init, ...(body === undefined ? {} : { body }), ...(signal === undefined ? {} : {
      signal: AbortSignal.any(options.signal === undefined ? [signal] : [signal, options.signal]),
    }) });
  };
}
async function callbackListener(signal: AbortSignal, port: number, expectedState: string) {
  let resolveUrl: (url: URL) => void = () => {};
  let rejectUrl: (error: Error) => void = () => {};
  const result = new Promise<URL>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject });
  void result.catch(() => {});
  let redirect = new URL("http://127.0.0.1/auth/callback");
  let accepting = true;
  const accept = (target: string): boolean => {
    let url: URL;
    try { url = new URL(target, redirect) } catch { return false }
    if (!accepting || signal.aborted || url.origin !== redirect.origin ||
        url.pathname !== redirect.pathname || url.searchParams.get("state") !== expectedState) return false;
    accepting = false;
    resolveUrl(url);
    return true;
  };
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !accept(request.url ?? "/")) {
      response.writeHead(400).end("Unrecognized authorization response."); return;
    }
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Authorization response received. Return to agent.");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve() });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new AuthError("exchange", "Could not open the ChatGPT callback.");
  redirect = new URL("http://127.0.0.1:" + address.port + "/auth/callback");
  const abort = () => rejectUrl(new AuthError("cancelled", "ChatGPT sign-in cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { redirect, result, accept, async close() {
    accepting = false;
    signal.removeEventListener("abort", abort);
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() });
  } };
}

/** One credential authority, protected by the runtime's process ownership guard. */
export class ChatGptAuth {
  private readonly issuer: URL;
  private readonly callbackPort: number;
  private queue: Promise<void> = Promise.resolve();
  private pendingCallback: ((target: string) => boolean) | undefined;
  constructor(private readonly stateDir: string, options: AuthOptions = {}) {
    this.issuer = options.testIssuer ?? new URL("https://auth.openai.com");
    if (options.testIssuer !== undefined && (this.issuer.protocol !== "http:" || this.issuer.hostname !== "127.0.0.1")) {
      throw new AuthError("discovery", "The test issuer must be an HTTP loopback server.");
    }
    this.callbackPort = options.callbackPort ?? 1455;
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  /** Only the authenticated active Login stream may call this ingress. It must
   * not queue behind login(), which is itself waiting for this response. */
  forwardCallback(target: string): boolean {
    return this.pendingCallback?.(target) ?? false;
  }
  private async read(): Promise<SavedAuth> {
    try {
      await chmod(this.stateDir, 0o700);
      await chmod(join(this.stateDir, "auth.json"), 0o600);
      const value: unknown = JSON.parse(await readFile(join(this.stateDir, "auth.json"), "utf8"));
      return readState(value);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw safeFailure(error, "storage", "Could not read private ChatGPT authentication state.");
      }
      const initial: SavedAuth = { version: 1, hostId: "urn:uuid:" + randomUUID(), connection: { state: "signed_out", registration: null } };
      await this.write(initial);
      return initial;
    }
  }
  private async write(state: SavedAuth): Promise<void> {
    const temporary = join(this.stateDir, ".auth-" + randomUUID() + ".tmp");
    try {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await chmod(this.stateDir, 0o700);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state), "utf8"); await file.sync() }
      finally { await file.close() }
      await rename(temporary, join(this.stateDir, "auth.json"));
      const directory = await open(this.stateDir, "r");
      try { await directory.sync() } finally { await directory.close() }
    } catch {
      throw new AuthError("storage", "Could not save private ChatGPT authentication state.");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  private async configuration(clientId: string, signal?: AbortSignal): Promise<oidc.Configuration> {
    try {
      return await oidc.discovery(this.issuer, clientId, { token_endpoint_auth_method: "none" }, oidc.None(), {
        timeout: 15,
        execute: this.issuer.protocol === "http:"
          ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
          : [oidc.enableNonRepudiationChecks],
        [oidc.customFetch]: requestFetch(signal),
      });
    } catch (error) { throw safeFailure(error, "discovery", "Could not discover the ChatGPT authentication service.") }
  }
  status(): Promise<AuthStatus> {
    return this.serialized(async () => statusOf((await this.read()).connection));
  }
  login(onUrl: (url: string) => void, signal: AbortSignal): Promise<AuthStatus> {
    return this.serialized(async () => {
      const state = await this.read();
      const previous = state.connection.registration;
      const pendingSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      let listener: Awaited<ReturnType<typeof callbackListener>> | undefined;
      try {
        const expectedState = oidc.randomState();
        listener = await callbackListener(pendingSignal, this.callbackPort, expectedState);
        this.pendingCallback = listener.accept;
        const config = await this.configuration(previous?.clientId ?? "dynamic_agent_client", pendingSignal);
        const verifier = oidc.randomPKCECodeVerifier();
        const nonce = oidc.randomNonce();
        const url = oidc.buildAuthorizationUrl(config, {
          redirect_uri: listener.redirect.href, response_type: "code", scope: SCOPES,
          resource: RESOURCE, ext_agent_host_id: state.hostId,
          ...(previous === null ? { agent_name_hint: "agent" } : {}),
          ...(previous?.idToken ? { id_token_hint: previous.idToken } : {}),
          state: expectedState, nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
        });
        pendingSignal.throwIfAborted();
        onUrl(url.href);
        const returned = await listener.result;
        if (returned.searchParams.has("error")) {
          // Error callbacks have no dynamically issued client ID. Let the OAuth
          // library validate and classify the response before success-only fields.
          await oidc.authorizationCodeGrant(config, returned, { expectedState });
        }
        const issued = returned.searchParams.get("client_id") ?? previous?.clientId;
        if (!issued || issued === "dynamic_agent_client" || (previous !== null && issued !== previous.clientId)) {
          throw new AuthError("registration", "ChatGPT returned an invalid registration.");
        }
        const grant = new oidc.Configuration(config.serverMetadata(), issued, { token_endpoint_auth_method: "none" }, oidc.None());
        oidc.enableNonRepudiationChecks(grant);
        if (this.issuer.protocol === "http:") oidc.allowInsecureRequests(grant);
        grant.timeout = 15;
        // State is validated by openid-client before its token request. Retain the
        // issued ID before exchanging the code, even when exchange later fails.
        grant[oidc.customFetch] = requestFetch(pendingSignal, async () => {
          if (previous === null) await this.write({ ...state, connection: {
            state: "needs_sign_in", registration: { clientId: issued, account: null, idToken: null },
          } });
        }, grant.serverMetadata().token_endpoint);
        const response = await oidc.authorizationCodeGrant(grant, returned, {
          pkceCodeVerifier: verifier, expectedState, expectedNonce: nonce, idTokenExpected: true,
        }, { resource: RESOURCE });
        const claims = response.claims();
        if (claims === undefined || response.id_token === undefined) throw new AuthError("validation", "ChatGPT identity was missing.");
        const selected: Registration & { account: AccountIdentity } = {
          clientId: issued, idToken: response.id_token,
          account: { issuer: claims.iss, subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null },
        };
        if (previous?.account && !sameAccount(previous.account, selected.account)) {
          throw new AuthError("validation", "ChatGPT returned a different account; the existing account was preserved.");
        }
        const scopes = response.scope?.split(/\s+/) ?? [];
        if (!scopes.includes(PLAN_SCOPE)) {
          await this.write({ ...state, connection: { state: "needs_sign_in", registration: selected } });
          throw new AuthError("permission", "Permission to use the ChatGPT plan was not granted.");
        }
        const expiresIn = response.expiresIn();
        if (!response.refresh_token || expiresIn === undefined || expiresIn <= 0) {
          throw new AuthError("validation", "ChatGPT returned an incomplete renewable credential.");
        }
        const connection: Connection = { state: "connected", registration: selected, tokens: {
          access: response.access_token, refresh: response.refresh_token,
          expiresAt: Math.floor(Date.now() / 1000) + expiresIn, scopes,
        } };
        await this.write({ ...state, connection });
        return statusOf(connection);
      } catch (error) {
        if (pendingSignal.aborted) throw new AuthError("cancelled", "ChatGPT sign-in cancelled.");
        throw safeFailure(error, "exchange", "Could not complete ChatGPT token exchange.");
      } finally { this.pendingCallback = undefined; await listener?.close() }
    });
  }
  credential(): Promise<OAuthCredential> {
    return this.serialized(async () => {
      const state = await this.read();
      const connection = state.connection;
      if (connection.state !== "connected") throw new AuthError("needs_sign_in", "Not signed in to ChatGPT. Run agent login.");
      let current = connection.tokens;
      if (current.expiresAt <= Math.floor(Date.now() / 1000) + 60) {
        try {
          const config = await this.configuration(connection.registration.clientId);
          const response = await oidc.refreshTokenGrant(config, current.refresh, { resource: RESOURCE });
          const claims = response.claims();
          if (claims !== undefined && !sameAccount(connection.registration.account, { issuer: claims.iss, subject: claims.sub, email: null })) {
            throw new AuthError("validation", "ChatGPT account changed during refresh.");
          }
          const scopes = response.scope?.split(/\s+/) ?? current.scopes;
          const expiresIn = response.expiresIn();
          if (!scopes.includes(PLAN_SCOPE) || expiresIn === undefined || expiresIn <= 0) {
            throw new AuthError("validation", "ChatGPT returned an invalid refreshed credential.");
          }
          current = { access: response.access_token, refresh: response.refresh_token ?? current.refresh,
            expiresAt: Math.floor(Date.now() / 1000) + expiresIn, scopes };
          await this.write({ ...state, connection: { ...connection, tokens: current,
            registration: { ...connection.registration, idToken: response.id_token ?? connection.registration.idToken },
          } });
        } catch (error) {
          if (error instanceof oidc.ResponseBodyError && error.error === "invalid_grant") {
            await this.write({ ...state, connection: { state: "needs_sign_in", registration: connection.registration } });
            throw new AuthError("needs_sign_in", "ChatGPT sign-in expired. Run agent login.");
          }
          throw safeFailure(error, "refresh", "Could not refresh ChatGPT authentication; retry later.");
        }
      }
      return { type: "oauth", clientId: connection.registration.clientId,
        access: current.access, refresh: current.refresh, expires: current.expiresAt * 1000, scopes: current.scopes };
    });
  }
  logout(): Promise<void> {
    return this.serialized(async () => {
      const state = await this.read();
      let revoked = true;
      if (state.connection.state === "connected") {
        try {
          const config = await this.configuration(state.connection.registration.clientId);
          await oidc.tokenRevocation(config, state.connection.tokens.refresh, { token_type_hint: "refresh_token" });
        } catch { revoked = false }
      }
      await this.write({ ...state, connection: { state: "signed_out", registration: state.connection.registration === null ? null : { ...state.connection.registration, idToken: null } } });
      if (!revoked) throw new AuthError("revocation", "Signed out locally; remote ChatGPT revocation was not confirmed.");
    });
  }
}
