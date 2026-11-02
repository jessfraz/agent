import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate, setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { inspect, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { BrowserHost } from "../src/browser-host.js";
import type { BrowserAction } from "../src/generated/BrowserAction.js";
import type { BrowserRequest } from "../src/generated/BrowserRequest.js";
import type { BrowserReply } from "../src/generated/BrowserReply.js";
import type { BrowserResponse } from "../src/generated/BrowserResponse.js";
declare const document: { title: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Explicit test binaries support normal extension loading. Never start personal Chrome by discovery.
const chrome = process.env.AGENT_TEST_CHROME;
const extensionDirectory = process.env.AGENT_TEST_PLAYWRIGHT_EXTENSION_DIR;
const extensionId = "mmlmfjhmonkocbjadbfplnigmagldckm";
const skipChrome = (chrome === undefined || extensionDirectory === undefined) && process.env.CI !== "true";

async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([operation, setTimeout(milliseconds, undefined, { signal: timer.signal, ref: false }).then(() => { throw new Error(message); })]);
  } finally { timer.abort(); }
}

function browserReply(value: unknown): value is BrowserReply {
  if (!object(value) || typeof value.operation_id !== "string" || !object(value.response)) return false;
  const response = value.response;
  if (typeof response.session_id !== "string") return false;
  if (response.type === "disconnected" || response.type === "failed" || response.type === "uncertain") return typeof response.message === "string";
  return (response.type === "closed" || response.type === "ready" && typeof response.is_error === "boolean")
    && typeof response.output === "string" && Array.isArray(response.tabs)
    && response.tabs.every((tab: unknown) => object(tab) && typeof tab.id === "number" && typeof tab.url === "string" && typeof tab.title === "string");
}

/** Sends simultaneous conversations through Agent's real Rust host service. */
class NativeBrowserBroker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<string, { resolve(reply: BrowserReply): void; reject(error: Error): void }>();
  private failure: Error | undefined;
  constructor(executable: string, helper: string, config: string, token: string) {
    const child = spawn(executable, [helper, config], { stdio: "pipe", env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } });
    this.child = child;
    this.exited = new Promise<void>(resolve => child.once("close", () => { this.fail(new Error("Native browser broker disconnected")); resolve(); }));
    child.once("error", () => this.fail(new Error("Native browser broker could not start")));
    child.stdin.on("error", () => this.fail(new Error("Native browser broker input closed")));
    child.stderr.resume();
    void (async () => {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const reply: unknown = JSON.parse(line); assert.ok(browserReply(reply), "Native browser broker must emit a typed BrowserReply");
        const pending = this.pending.get(reply.operation_id); assert.ok(pending, "Native browser reply must belong to a pending operation");
        this.pending.delete(reply.operation_id); pending.resolve(reply);
      }
    })().catch(() => this.fail(new Error("Native browser broker returned an invalid receipt")));
  }
  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async execute(request: BrowserRequest): Promise<BrowserReply> {
    if (this.failure !== undefined) throw this.failure;
    assert.equal(this.pending.has(request.operation_id), false);
    const reply = new Promise<BrowserReply>((resolve, reject) => this.pending.set(request.operation_id, { resolve, reject }));
    this.child.stdin.write(JSON.stringify(request) + "\n");
    try { return await within(reply, 45_000, "Native browser broker did not confirm the operation"); }
    finally { this.pending.delete(request.operation_id); }
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    if (await exitsWithin(this.exited, 5000)) return;
    this.child.kill("SIGTERM");
    if (await exitsWithin(this.exited, 5000)) return;
    this.child.kill("SIGKILL");
    assert.ok(await exitsWithin(this.exited, 5000), "The exact owned native browser broker must exit");
  }
}

/** Fixture setup uses the browser protocol directly; assertions exercise Agent's real MCP adapter. */
class ChromeFixtureClient {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  constructor(endpoint: string) {
    this.socket = new WebSocket(endpoint);
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Synthetic Chrome could not connect")), { once: true });
    });
    this.socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      const value: unknown = JSON.parse(event.data);
      if (!object(value) || typeof value.id !== "number") return;
      const pending = this.pending.get(value.id);
      if (pending === undefined) return;
      this.pending.delete(value.id);
      if (object(value.result)) pending.resolve(value.result);
      else {
        const detail = object(value.error) && typeof value.error.message === "string"
          ? value.error.message.replace(/token=[^&\s"']+/g, "token=[redacted]") : "unknown protocol error";
        pending.reject(new Error(`Synthetic Chrome rejected ${pending.method}: ${detail}`));
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Synthetic Chrome disconnected"));
      this.pending.clear();
    });
  }
  async call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    await within(this.ready, 8000, "Synthetic Chrome protocol connection timed out");
    const id = this.nextId++;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
    try { return await within(result, 8000, `Synthetic Chrome ${method} timed out`); }
    finally { this.pending.delete(id); }
  }
  async pages(): Promise<{ targetId: string; url: string }[]> {
    const result = await this.call("Target.getTargets");
    assert.ok(Array.isArray(result.targetInfos));
    return result.targetInfos.flatMap((item: unknown) => object(item) && item.type === "page" && typeof item.targetId === "string" && typeof item.url === "string"
      ? [{ targetId: item.targetId, url: item.url }] : []);
  }
  async activate(url: string): Promise<void> {
    const page = (await this.pages()).find(page => page.url === url); assert.ok(page);
    const attached = await this.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    assert.ok(typeof attached.sessionId === "string");
    try { await this.call("Page.bringToFront", {}, attached.sessionId); }
    finally { await this.call("Target.detachFromTarget", { sessionId: attached.sessionId }); }
  }
  async nativeState(url: string): Promise<Record<string, unknown>> {
    const page = (await this.pages()).find(page => page.url === url); assert.ok(page);
    const attached = await this.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    assert.ok(typeof attached.sessionId === "string");
    try {
      // Inspect native foreground state, independently of MCP's focus emulation.
      await this.call("Emulation.setFocusEmulationEnabled", { enabled: false }, attached.sessionId);
      const inspected = await this.call("Runtime.evaluate", {
        expression: `({ visible: document.visibilityState, focused: document.hasFocus(),
          value: document.querySelector('input[name=name]')?.value ?? null,
          active: document.activeElement?.getAttribute('name') ?? null })`, returnByValue: true,
      }, attached.sessionId);
      assert.ok(object(inspected.result) && object(inspected.result.value));
      return inspected.result.value;
    } finally { await this.call("Target.detachFromTarget", { sessionId: attached.sessionId }); }
  }
  async evaluate(targetId: string, expression: string): Promise<unknown> {
    const attached = await this.call("Target.attachToTarget", { targetId, flatten: true });
    assert.ok(typeof attached.sessionId === "string");
    try {
      const evaluated = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, attached.sessionId);
      assert.ok(object(evaluated.result), "Fixture evaluation must return a native result");
      assert.equal(evaluated.exceptionDetails, undefined, "Fixture evaluation must succeed");
      return evaluated.result.value;
    } finally { await this.call("Target.detachFromTarget", { sessionId: attached.sessionId }); }
  }
  async controlDialogs(url: string) {
    const page = (await this.pages()).find(page => page.url === url); assert.ok(page);
    const attached = await this.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    assert.ok(typeof attached.sessionId === "string");
    const sessionId = attached.sessionId;
    await this.call("Page.enable", {}, sessionId);
    return { dismiss: () => this.call("Page.handleJavaScriptDialog", { accept: false }, sessionId),
      close: () => this.call("Target.detachFromTarget", { sessionId }) };
  }
  close(): void { this.socket.close(); }
}

async function exitsWithin(exited: Promise<void>, milliseconds: number): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([exited.then(() => true), setTimeout(milliseconds, false, { signal: timer.signal, ref: false })]);
  } finally { timer.abort(); }
}

async function closeChrome(browser: ChildProcess, exited: Promise<void>, client: ChromeFixtureClient | undefined): Promise<void> {
  const group = process.platform !== "win32" ? browser.pid : undefined;
  const signal = (value: NodeJS.Signals) => {
    if (group === undefined) { browser.kill(value); return; }
    try { process.kill(-group, value); }
    catch (error) { if (!object(error) || error.code !== "ESRCH") throw error; }
  };
  const groupAlive = () => {
    if (group === undefined) return false;
    try { process.kill(-group, 0); return true; }
    catch (error) { if (object(error) && error.code === "ESRCH") return false; throw error; }
  };
  const stopped = async () => {
    const deadline = performance.now() + 5_000;
    if (!await exitsWithin(exited, 5_000)) return false;
    while (groupAlive()) {
      if (performance.now() >= deadline) return false;
      await setTimeout(25);
    }
    return true;
  };
  let protocolError: unknown;
  if (client !== undefined && browser.exitCode === null && browser.signalCode === null) {
    // Chrome may close CDP before acknowledging Browser.close. Its own process
    // completion is authoritative; allow that graceful shutdown to finish.
    void client.call("Browser.close").catch(error => { protocolError = error; });
  }
  if (await stopped()) return;
  // Only this fixture's detached group is owned. Descendants can retain stderr
  // after the browser exits, so both stdio completion and group exit matter.
  signal("SIGTERM");
  if (await stopped()) return;
  signal("SIGKILL");
  if (!await stopped()) throw new Error("Disposable Chrome process group or stdio did not stop during fixture cleanup", { cause: protocolError });
}

async function fixture(t: TestContext, options: { slowSubmit?: boolean; foreignFrame?: boolean } = {}) {
  assert.ok(chrome && existsSync(chrome), "AGENT_TEST_CHROME must name a disposable-test-capable Chrome binary");
  assert.ok(extensionDirectory && existsSync(extensionDirectory), "AGENT_TEST_PLAYWRIGHT_EXTENSION_DIR must name the extracted official extension");
  const manifest: unknown = JSON.parse(await readFile(join(extensionDirectory, "manifest.json"), "utf8"));
  assert.ok(object(manifest) && typeof manifest.key === "string");
  const manifestId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)]
    .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
  assert.equal(manifestId, extensionId, "The fixture must use the official extension identity");
  let submissions = 0;
  const submittedForms: { path: string; body: string }[] = [];
  let delayed: ServerResponse | undefined;
  let validation: ServerResponse | undefined;
  let validationFinished = false;
  let submittedResolve = () => {};
  const submitted = new Promise<void>(resolve => { submittedResolve = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/validate") {
      // Alpha's native Save waits for server validation while Beta can submit.
      if (url.searchParams.get("owner") === "alpha" && !validationFinished) validation = response;
      else response.end("valid");
      return;
    }
    if (url.pathname === "/submit") {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        submittedForms.push({ path: url.pathname + url.search, body }); submissions++; submittedResolve();
        if (options.slowSubmit) { delayed = response; return; }
        response.writeHead(303, { Location: "/done" + url.search }).end();
      });
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/form" && !request.headers.cookie?.includes("fixture_login=signed-in")) {
      response.writeHead(401).end("<!doctype html><h1>Sign in required</h1>"); return;
    }
    if (url.pathname === "/inline-password") response.end(`<!doctype html><label>Password<input type="password"></label><output></output>
      <script>const field=document.querySelector('input');field.value='SYNTHETIC_INLINE_PASSWORD_42';document.querySelector('output').textContent=field.value;field.value='';</script>`);
    else if (url.pathname === "/form") response.end(`<!doctype html><title>Owned form</title><h1>Form ready</h1>
      <form action="/submit${url.search}" method="post"><label>Name<input name="name"></label>
      <label>Choice<select name="choice" onchange="const button=this.form.querySelector('button[type=submit]'); button.disabled=true; fetch('/validate${url.search}').then(response => { if(response.ok) button.disabled=false; });"><option>First</option><option>Second</option></select></label>
      <button type="button" onclick="window.open('/popup','_blank')">Open popup</button>
      <button type="button" onclick="alert('Fixture dialog')">Open dialog</button>
      <button type="button" onclick="alert('First sequential dialog'); alert('Second sequential dialog')">Open two dialogs</button><button type="submit">Save</button></form>`);
    else if (url.pathname === "/done") response.end("<!doctype html><title>Saved form</title><h1>Saved</h1>");
    else if (request.url === "/popup") response.end("<!doctype html><title>Owned popup</title><h1>Popup ready</h1>");
    else if (url.pathname === "/embedded") response.end("<!doctype html><label>Frame note<input name=note></label>");
    else if (url.pathname === "/password") response.end("<!doctype html><title>Owned password form</title><form>"
      + '<label>Normal field<input name=normal value="Visible normal field"></label><label>Password<input name=password type=password></label>'
      + '<button type=button onclick="const field=this.form.elements.password; const value=field.value; field.value=\'\'; prompt(value,value)">Clear password into dialog</button>'
      + '<iframe title="Password frame" src="/password-frame"></iframe></form>');
    else if (url.pathname === "/password-frame") response.end("<!doctype html><label>Frame password<input name=frame-password type=password></label>");
    else if (request.url === "/retained") response.end("<!doctype html><title>Retained result</title><h1>Draft ready for review</h1>");
    else if (url.pathname === "/beforeunload") response.end(`<!doctype html><title>Owned draft</title><button onclick="this.textContent='Draft edited'">Edit draft</button>
      <script>addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue=''; });</script>`);
    else response.end("<!doctype html><title>User tab sentinel</title><h1>Unrelated user content sentinel</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-test-"));
  const extensions = [extensionDirectory];
  if (options.foreignFrame) {
    const menu = join(directory, "foreign-menu"); await mkdir(menu);
    await writeFile(join(menu, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Synthetic inline menu", version: "1.0",
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["inject.js"], run_at: "document_start" }],
      web_accessible_resources: [{ resources: ["menu.html"], matches: ["http://127.0.0.1/*"] }] }));
    await writeFile(join(menu, "menu.html"), "<!doctype html><p>Synthetic menu</p>");
    await writeFile(join(menu, "inject.js"), `let inserted = false;
document.addEventListener('focusin', event => {
  if (inserted || location.origin !== ${JSON.stringify(origin)} || !(event.target instanceof HTMLInputElement)) return;
  inserted = true;
  const host = document.createElement('fixture-inline-menu');
  const frame = document.createElement('iframe'); frame.src = chrome.runtime.getURL('menu.html');
  host.attachShadow({mode:'closed'}).append(frame); document.documentElement.append(host);
});
`);
    extensions.push(menu);
  }
  // Unix socket names are short even when macOS TMPDIR is deeply nested.
  const sockets = await mkdtemp("/tmp/agent-browser-sockets-");
  type Running = { browser: ChildProcess; exited: Promise<void>; client: ChromeFixtureClient };
  const processes: { browser: ChildProcess; exited: Promise<void>; client?: ChromeFixtureClient }[] = [];
  let active: Running | undefined;
  let statusTarget: string | undefined;
  const hosts: BrowserHost[] = [];
  const brokers: NativeBrowserBroker[] = [];
  const observers: Browser[] = [];
  const environment = { PWTEST_SERVER_REGISTRY: join(directory, "registry"), PWTEST_DAEMON_SESSION_DIR: join(directory, "sessions"),
    PWTEST_SOCKETS_DIR: sockets, PWTEST_CLI_CHANNEL_SCAN_DISABLED_FOR_TEST: "1" };
  // Headless Chrome does not implement headed single-instance URL forwarding.
  // Forward only the validated connector to this fixture's existing native driver.
  // The official extension, MCP server, relay, and typed adapter stay unchanged.
  const bridgePath = join(sockets, "launcher.sock");
  const bridge = createSocketServer(socket => {
    let buffer = "", dispatched = false;
    socket.setEncoding("utf8"); socket.setTimeout(8000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (dispatched) return;
      buffer += chunk;
      if (buffer.length > 64 * 1024) { socket.destroy(); return; }
      const end = buffer.indexOf("\n"); if (end < 0) return;
      dispatched = true;
      void (async () => {
        const request: unknown = JSON.parse(buffer.slice(0, end));
        if (!object(request) || request.profile !== directory || request.profileName !== "Default" || typeof request.url !== "string") throw new Error("Invalid fixture launcher request");
        const url = new URL(request.url);
        if (url.protocol !== "chrome-extension:" || url.hostname !== extensionId || url.pathname !== "/connect.html" || active === undefined) throw new Error("Invalid fixture connector target");
        await active.client.call("Target.createTarget", { url: request.url, background: true });
      })().then(() => socket.end("ok\n"), () => socket.end("error\n"));
    });
  });
  const launcher = join(directory, "guarded-chrome.mjs");
  await writeFile(launcher, `#!${process.execPath}
import { connect } from 'node:net';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== ${JSON.stringify(`--user-data-dir=${directory}`)} || args[1] !== '--profile-directory=Default') process.exit(64);
let url; try { url = new URL(args[2]); } catch { process.exit(64); }
if (url.protocol !== 'chrome-extension:' || url.hostname !== ${JSON.stringify(extensionId)} || url.pathname !== '/connect.html') process.exit(64);
writeFileSync(${JSON.stringify(join(directory, "mcp.pid"))}, String(process.ppid));
const socket = connect(${JSON.stringify(bridgePath)});
socket.setEncoding('utf8'); socket.setTimeout(8000, () => process.exit(65));
socket.on('error', () => process.exit(65));
socket.once('connect', () => socket.write(JSON.stringify({ profile: ${JSON.stringify(directory)}, profileName: 'Default', url: args[2] }) + '\\n'));
socket.once('data', data => { socket.destroy(); process.exit(data === 'ok\\n' ? 0 : 65); });
`);
  await chmod(launcher, 0o700);
  t.after(async () => {
    const failures: unknown[] = [];
    let stopped = true;
    for (const broker of brokers) try { await broker.close(); } catch (error) { failures.push(error); }
    for (const observer of observers) try { await within(observer.close(), 5000, "Public observer disconnect timed out"); } catch (error) { failures.push(error); }
    for (const host of hosts) try { await within(host.close(), 10_000, "Browser host cleanup timed out"); } catch (error) { failures.push(error); }
    for (const process of processes) {
      try { await closeChrome(process.browser, process.exited, process.client); }
      catch (error) { failures.push(error); stopped = false; }
      process.client?.close();
    }
    delayed?.end(); validation?.end();
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))); }
    catch (error) { failures.push(error); }
    try { await within(new Promise<void>(resolve => bridge.close(() => resolve())), 10_000, "Fixture launcher bridge did not close"); }
    catch (error) { failures.push(error); }
    if (stopped) {
      try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      try { await rm(sockets, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      const error = new AggregateError(failures, "Chrome fixture cleanup failed");
      // Node preserves a failed test body but otherwise omits its hook error.
      t.diagnostic(inspect(error)); throw error;
    }
  });
  async function startBrowser(): Promise<Running> {
    assert.ok(chrome && extensionDirectory);
    await unlink(join(directory, "DevToolsActivePort")).catch(() => {});
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${directory}`,
      `--disable-extensions-except=${extensions.join(",")}`, `--load-extension=${extensions.join(",")}`, "--use-mock-keychain", "--password-store=basic",
      "--disable-background-networking", "--disable-component-update", "--no-first-run", "--no-default-browser-check", "about:blank"];
    // Match Playwright's disposable Linux fixture launch under Ubuntu AppArmor.
    if (process.platform === "linux" || process.getuid?.() === 0) args.unshift("--no-sandbox");
    const browser = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
    let startupOutput = "";
    const captureStartup = (chunk: Buffer) => { startupOutput = (startupOutput + chunk.toString("utf8")).slice(-8192); };
    browser.stderr?.on("data", captureStartup);
    const exited = new Promise<void>(resolve => browser.once("close", () => resolve()));
    const tracked: { browser: ChildProcess; exited: Promise<void>; client?: ChromeFixtureClient } = { browser, exited };
    processes.push(tracked);
    let startupError: Error | undefined;
    browser.once("error", error => { startupError = error; });
    let endpoint = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const [port, path] = (await readFile(join(directory, "DevToolsActivePort"), "utf8")).trim().split("\n");
        if (port && path) { endpoint = `ws://127.0.0.1:${port}${path}`; break; }
      } catch { /* The exact disposable process has not published its endpoint yet. */ }
      if (startupError !== undefined) throw startupError;
      if (browser.exitCode !== null || browser.signalCode !== null) throw new Error("Synthetic Chrome exited before publishing its endpoint: "
        + startupOutput.replace(/(PLAYWRIGHT_MCP_EXTENSION_TOKEN=|token=)[^&\s"']+/g, "$1[redacted]"));
      await setTimeout(50);
    }
    assert.notEqual(endpoint, "", "Disposable Chrome must start within ten seconds");
    browser.stderr?.off("data", captureStartup); browser.stderr?.resume();
    const client = new ChromeFixtureClient(endpoint); tracked.client = client;
    const status = await client.call("Target.createTarget", { url: `chrome-extension://${extensionId}/status.html`, background: true });
    assert.ok(typeof status.targetId === "string"); statusTarget = status.targetId;
    return { browser, exited, client };
  }
  const current = () => { assert.ok(active); return active; };
  async function readToken(): Promise<string> {
    assert.ok(statusTarget);
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = await current().client.evaluate(statusTarget, "document.querySelector('.auth-token-code')?.textContent ?? null");
      const token = typeof text === "string" ? /^PLAYWRIGHT_MCP_EXTENSION_TOKEN=([A-Za-z0-9_-]{32,})$/.exec(text)?.[1] : undefined;
      if (token !== undefined) return token;
      await setTimeout(50);
    }
    throw new Error("The official extension did not publish its pairing token");
  }
  const statusEval = async (expression: string) => { assert.ok(statusTarget); return current().client.evaluate(statusTarget, expression); };
  await new Promise<void>((resolve, reject) => { bridge.once("error", reject); bridge.listen(bridgePath, () => resolve()); });
  active = await startBrowser();
  const token = await readToken();
  await active.client.call("Storage.setCookies", { cookies: [{ name: "fixture_login", value: "signed-in", url: origin, httpOnly: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }] });
  await active.client.call("Target.createTarget", { url: `${origin}/unrelated` });
  const sentinelGroup = await statusEval(`(async () => { for (let attempt = 0; attempt < 100; attempt++) { const tab = (await chrome.tabs.query({})).find(tab => tab.url === ${JSON.stringify(`${origin}/unrelated`)}); if (tab?.id) return await chrome.tabs.group({tabIds:[tab.id]}); await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Missing loaded fixture sentinel'); })()`);
  assert.ok(typeof sentinelGroup === "number");
  const serverArguments = ["--extension", "--browser", "chrome", "--executable-path", launcher, "--user-data-dir", directory, "--profile-dir-name", "Default"];
  const newHost = () => {
    const host = new BrowserHost({ user_data_dir: directory, profile_dir_name: "Default" }, {
      serverArguments,
      // Exercise the extension Copy button's assignment form, then raw tokens on later helpers.
      extensionToken: hosts.length === 0 ? `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token}` : token, environment,
    });
    hosts.push(host); return host;
  };
  return {
    origin, pairingToken: token, get browser() { return current().browser; }, get client() { return current().client; }, submitted, host: newHost(), newHost,
    finishValidation() { validationFinished = true; validation?.end("valid"); validation = undefined; },
    async waitForActiveTab(url: string) {
      await within((async () => {
        while (await statusEval("(async () => (await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]?.url ?? null)()") !== url) await setTimeout(10);
      })(), 5000, "The pending native input must activate its owned tab");
    },
    async nativeBroker() {
      const executable = process.env.AGENT_TEST_BROWSER_BROKER ?? fileURLToPath(new URL("../../../target/debug/examples/browser_fixture", import.meta.url));
      assert.ok(existsSync(executable), "Build the native browser fixture with cargo build --example browser_fixture");
      const runtime = join(directory, "native-runtime"); await mkdir(runtime);
      const helper = join(runtime, "browser-host.js");
      await writeFile(join(runtime, "package.json"), '{"type":"module"}');
      // Only transport setup differs from the shipped helper. Browser behavior
      // remains in the same BrowserHost used by every direct adapter test.
      await writeFile(helper, `import { createInterface } from 'node:readline';
import { BrowserHost } from ${JSON.stringify(new URL("../src/browser-host.js", import.meta.url).href)};
const host = new BrowserHost(JSON.parse(process.argv[2]), ${JSON.stringify({ serverArguments, environment })});
const stop = () => { void host.close().finally(() => process.exit(0)); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const reply = await host.execute(JSON.parse(line));
    process.stdout.write(JSON.stringify(reply) + '\\n');
  }
} finally { await host.close(); }
`);
      const broker = new NativeBrowserBroker(executable, helper,
        JSON.stringify({ user_data_dir: directory, profile_dir_name: "Default", credential_command: null }), `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token}`);
      brokers.push(broker); return broker;
    },
    async observeOwnedPage(sessionId: string, url: string) {
      // Public CLI discovery is used only to test the upstream Page-close receipt contract.
      const cli = fileURLToPath(new URL("./playwright-cli.js", import.meta.resolve("@playwright/cli/package.json")));
      const env: Record<string, string> = { ...environment, NO_UPDATE_NOTIFIER: "1" };
      for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) { const value = process.env[name]; if (value !== undefined) env[name] = value; }
      const listed = await promisify(execFile)(process.execPath, [cli, "list", "--all", "--json"], { cwd: directory, env, timeout: 15_000 });
      const inventory: unknown = JSON.parse(listed.stdout);
      assert.ok(object(inventory) && Array.isArray(inventory.servers));
      const servers = inventory.servers.filter((item: unknown) => object(item) && item.title === `Beep Boop ${sessionId}`);
      assert.equal(servers.length, 1);
      const server: unknown = servers[0]; assert.ok(object(server) && typeof server.endpoint === "string");
      const { chromium } = await import("playwright-core");
      const browser = await chromium.connect(server.endpoint, { timeout: 10_000 }); observers.push(browser);
      const pages = browser.contexts()[0]?.pages(); assert.ok(pages); assert.equal(pages.length, 1);
      const page = pages[0]; assert.ok(page); assert.equal(page.url(), url);
      return { browser, page };
    },
    async restartBrowser() {
      const previous = current(); await closeChrome(previous.browser, previous.exited, previous.client); previous.client.close();
      active = await startBrowser();
      assert.ok(await readToken() === token, "The same official pairing token must survive Chrome restart without reinstalling the extension");
    },
    async assertUnrelatedGroup() {
      assert.equal(await statusEval(`(async () => (await chrome.tabs.query({})).find(tab => tab.url === ${JSON.stringify(`${origin}/unrelated`)})?.groupId)()`), sentinelGroup,
        "The pre-existing unrelated Chrome group must survive");
    },
    async dragIntoTaskGroup(unrelatedUrl: string, ownedUrl: string) {
      await statusEval(`(async () => { const tabs = await chrome.tabs.query({}); const owned = tabs.find(tab => tab.url === ${JSON.stringify(ownedUrl)}); const unrelated = tabs.find(tab => tab.url === ${JSON.stringify(unrelatedUrl)}); if (!owned || !unrelated?.id || owned.groupId < 0) throw new Error('Missing fixture group'); await chrome.tabs.group({tabIds:[unrelated.id],groupId:owned.groupId}); })()`);
    },
    async pauseMcp() {
      // The rejecting fixture launcher records its real parent, the task-owned MCP process.
      const pid = Number((await readFile(join(directory, "mcp.pid"), "utf8")).trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
      process.kill(pid, "SIGSTOP");
      let killed = false;
      return { kill() { if (!killed) { killed = true; process.kill(pid, "SIGKILL"); } } };
    },
    assertNoBootstrapDetails(value: unknown) {
      const serialized = JSON.stringify(value);
      assert.equal(serialized.includes(token.slice(0, Math.ceil(token.length / 2))), false, "No pairing token prefix may escape a response");
      assert.equal(serialized.includes("chrome-extension://"), false);
    },
    count: () => submissions,
    submittedBodies: () => submittedForms.map(form => form.body),
    submittedForms: () => submittedForms.map(form => ({ ...form })),
    finishSubmission() { delayed?.writeHead(303, { Location: "/done" }).end(); delayed = undefined; },
  };
}

function requests(owner_id: string = randomUUID()) {
  const session_id = randomUUID();
  return (action: BrowserAction, operation_id = randomUUID()): BrowserRequest => ({ owner_id, session_id, operation_id, action });
}

function elementRef(output: string, role: string, name: string): string {
  const value: unknown = JSON.parse(output);
  assert.ok(object(value));
  function find(node: unknown): string | undefined {
    if (Array.isArray(node)) {
      for (const child of node) { const found = find(child); if (found !== undefined) return found; }
      return undefined;
    }
    if (!object(node)) return undefined;
    if (node.role === role && node.name === name && typeof node.ref === "string") return node.ref;
    if (Array.isArray(node.children)) for (const child of node.children) { const found = find(child); if (found !== undefined) return found; }
    return undefined;
  }
  const result = find(value.snapshot); assert.ok(result, `Snapshot must contain ${role} ${name}`); return result;
}

test("public runBeforeUnload close acknowledges before the final controlled page disconnects", { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), request = requests();
  const operation = request({ type: "open", url: `${f.origin}/form` });
  const opened = (await f.host.execute(operation)).response;
  assert.ok(opened.type === "ready"); assert.equal(opened.tabs.length, 1);
  const native = await f.observeOwnedPage(operation.session_id, `${f.origin}/form`);
  const order: string[] = [];
  const pageClosed = new Promise<void>(resolve => native.page.once("close", () => { order.push("page-close"); resolve(); }));
  const disconnected = new Promise<void>(resolve => native.browser.once("disconnected", () => { order.push("browser-disconnected"); resolve(); }));
  await within(native.page.close({ runBeforeUnload: true }), 10_000, "Public beforeunload close did not acknowledge");
  order.push("close-command-ack");
  await within(pageClosed, 10_000, "The acknowledged final page did not close");
  await within(disconnected, 10_000, "Final controlled page must disconnect its extension relay");
  assert.ok(order.indexOf("close-command-ack") < order.indexOf("browser-disconnected"), JSON.stringify(order));
  assert.equal((await f.client.pages()).some(page => page.url === `${f.origin}/form`), false);
  await f.assertUnrelatedGroup();
  assert.equal(f.browser.exitCode, null);
  t.diagnostic(JSON.stringify({ finalControlledPageCloseOrder: order }));
});

test("public runBeforeUnload close acknowledges a pending dialog without claiming the draft closed", { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), request = requests(), url = `${f.origin}/beforeunload`;
  const operation = request({ type: "open", url });
  const opened = (await f.host.execute(operation)).response;
  assert.ok(opened.type === "ready");
  const native = await f.observeOwnedPage(operation.session_id, url);
  await native.page.getByRole("button", { name: "Edit draft" }).click();
  const firstDialog = native.page.waitForEvent("dialog", { timeout: 5000 });
  const firstClose = native.page.close({ runBeforeUnload: true });
  void firstClose.catch(() => {});
  const dismissed = await firstDialog;
  assert.equal(dismissed.type(), "beforeunload");
  await within(firstClose, 5000, "Close must acknowledge while beforeunload remains pending");
  assert.equal(native.page.isClosed(), false);
  assert.ok((await f.client.pages()).some(page => page.url === url));
  await dismissed.dismiss();
  assert.equal(native.page.isClosed(), false, "Dismissing beforeunload keeps the owned draft");
  const nextDialog = native.page.waitForEvent("dialog", { timeout: 5000 });
  const pageClosed = new Promise<void>(resolve => native.page.once("close", () => resolve()));
  const acceptedClose = native.page.close({ runBeforeUnload: true }); void acceptedClose.catch(() => {});
  const accepted = await nextDialog;
  assert.equal(accepted.type(), "beforeunload");
  await within(acceptedClose, 5000, "Second close must acknowledge before accepting the dialog");
  await accepted.accept();
  await within(pageClosed, 10_000, "Accepting beforeunload must close the exact draft");
  assert.equal((await f.client.pages()).some(page => page.url === url), false);
  await f.assertUnrelatedGroup();
  t.diagnostic("Public close acknowledgement precedes beforeunload decision; native closure follows acceptance.");
});

test("real Chrome adapter owns exact tabs and scoped popups, preserves unrelated pages and deduplicates mutations", { skip: skipChrome, timeout: 120_000 }, async t => {
  const f = await fixture(t), host = f.host, request = requests();
  const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
  assert.ok(opened.type === "ready", JSON.stringify(opened)); assert.equal(opened.is_error, false);
  assert.equal(opened.tabs.length, 1); const tab = opened.tabs[0]; assert.ok(tab);
  assert.equal(tab.url, `${f.origin}/form`);
  f.assertNoBootstrapDetails(opened);
  assert.equal(JSON.stringify(opened).includes("User tab sentinel"), false);
  assert.equal(JSON.stringify(opened).includes("Unrelated user content sentinel"), false);
  const mismatch = (await host.execute({ ...request({ type: "new_tab", url: `${f.origin}/form` }), owner_id: randomUUID() })).response;
  assert.equal(mismatch.type, "failed");
  const unowned = (await host.execute(request({ type: "close_tab", tab_id: 0xffff_ffff }))).response;
  assert.equal(unowned.type, "failed");

  const filled = (await host.execute(request({ type: "fill", tab_id: tab.id, element_ref: elementRef(opened.output, "textbox", "Name"), value: "Synthetic user" }))).response;
  assert.ok(filled.type === "ready", JSON.stringify(filled)); assert.equal(filled.is_error, false);
  const selected = (await host.execute(request({ type: "fill", tab_id: tab.id, element_ref: elementRef(filled.output, "combobox", "Choice"), value: "Second" }))).response;
  assert.ok(selected.type === "ready", JSON.stringify(selected)); assert.equal(selected.is_error, false);
  const waited = (await host.execute(request({ type: "wait_for", tab_id: tab.id, text: "Form ready" }))).response;
  assert.ok(waited.type === "ready"); assert.equal(waited.is_error, false);

  const popupRequest = request({ type: "click", tab_id: tab.id, element_ref: elementRef(waited.output, "button", "Open popup") });
  const popupPending = host.execute(popupRequest);
  await f.client.call("Target.createTarget", { url: `${f.origin}/user-concurrent`, background: true });
  const popup = (await popupPending).response;
  assert.ok(popup.type === "ready", JSON.stringify(popup)); assert.equal(popup.is_error, false);
  assert.equal(popup.tabs.length, 2); assert.ok(popup.tabs.some(page => page.url === `${f.origin}/popup`));
  assert.equal(JSON.stringify(popup).includes("user-concurrent"), false);
  const nativeDialogs = await f.client.controlDialogs(tab.url);
  try {
    const dialog = (await host.execute(request({ type: "click", tab_id: tab.id, element_ref: elementRef(popup.output, "button", "Open dialog") }))).response;
    assert.ok(dialog.type === "ready"); assert.ok(dialog.output.includes("Fixture dialog"));
    await nativeDialogs.dismiss();
  } finally { await nativeDialogs.close(); }
  const dismissed = await within((async () => {
    for (;;) {
      const response = (await host.execute(request({ type: "snapshot", tab_id: tab.id }))).response;
      if (response.type === "ready" && response.output.includes("Form ready")) return response;
      await setTimeout(25);
    }
  })(), 5000, "A user-side native dialog dismissal must clear the adapter modal state");
  const firstSequential: BrowserResponse = (await host.execute(request({ type: "click", tab_id: tab.id,
    element_ref: elementRef(dismissed.output, "button", "Open two dialogs") }))).response;
  assert.ok(firstSequential.type === "ready"); assert.ok(firstSequential.output.includes("First sequential dialog"));
  const secondSequential = (await host.execute(request({ type: "handle_dialog", tab_id: tab.id, accept: true, prompt_text: null }))).response;
  assert.ok(secondSequential.type === "ready"); assert.ok(secondSequential.output.includes("Second sequential dialog"));
  const accepted = (await host.execute(request({ type: "handle_dialog", tab_id: tab.id, accept: true, prompt_text: null }))).response;
  assert.ok(accepted.type === "ready"); assert.equal(accepted.is_error, false); assert.ok(accepted.output.includes("Form ready"));

  const submission = request({ type: "click", tab_id: tab.id, element_ref: elementRef(accepted.output, "button", "Save") });
  const saved = (await host.execute(submission)).response;
  assert.ok(saved.type === "ready", JSON.stringify(saved)); assert.equal(saved.is_error, false); assert.equal(f.count(), 1);
  const body = new URLSearchParams(f.submittedBodies()[0]);
  assert.equal(body.get("name"), "Synthetic user");
  assert.equal(body.get("choice"), "Second");
  assert.equal((await host.execute(submission)).response.type, "failed"); assert.equal(f.count(), 1, "A reused operation ID cannot submit twice");
  const inspection = request({ type: "status" });
  const inspected = (await host.execute(inspection)).response;
  assert.ok(inspected.type === "ready"); assert.equal(inspected.tabs.length, 2);
  const resultTab = (await host.execute(request({ type: "new_tab", url: `${f.origin}/retained` }))).response;
  assert.ok(resultTab.type === "ready"); const retained = resultTab.tabs.find(page => page.url === `${f.origin}/retained`); assert.ok(retained);
  const replayedRead = (await host.execute(inspection)).response;
  assert.ok(replayedRead.type === "ready");
  assert.equal(replayedRead.tabs.length, 3, "A replay-safe status gets fresh state while duplicate mutations stay fenced");
  const retainedResult = (await host.execute(request({ type: "retain_tab", tab_id: retained.id }))).response;
  assert.ok(retainedResult.type === "ready"); assert.equal(retainedResult.tabs.some(page => page.id === retained.id), false);
  await f.dragIntoTaskGroup(`${f.origin}/user-concurrent`, `${f.origin}/retained`);
  const released = (await host.execute(request({ type: "release" }))).response;
  assert.ok(released.type === "closed", JSON.stringify(released)); assert.equal(released.tabs.length, 0);
  const pages = await f.client.pages();
  assert.ok(pages.some(page => page.url === `${f.origin}/unrelated`));
  assert.ok(pages.some(page => page.url === `${f.origin}/user-concurrent`));
  assert.ok(pages.some(page => page.url === `${f.origin}/retained`), "An explicitly retained draft must survive cleanup");
  assert.equal(pages.some(page => page.url === `${f.origin}/done` || page.url === `${f.origin}/popup`), false);
  await host.close();
  assert.ok((await f.client.pages()).some(page => page.url === `${f.origin}/retained`), "The retained draft must survive typed Browser and MCP disposal");
  await f.assertUnrelatedGroup();
  assert.equal(f.browser.exitCode, null, "Disconnect must leave attached Chrome running");
});

test("stale element failure still permits status and retention of the same owned page", { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), request = requests();
  const opened = (await f.host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
  assert.ok(opened.type === "ready"); const tab = opened.tabs[0]; assert.ok(tab);
  const stale = elementRef(opened.output, "combobox", "Choice");
  const saved = (await f.host.execute(request({ type: "click", tab_id: tab.id, element_ref: elementRef(opened.output, "button", "Save") }))).response;
  assert.ok(saved.type === "ready"); assert.equal(saved.is_error, false);
  const failed = (await f.host.execute(request({ type: "fill", tab_id: tab.id, element_ref: stale, value: "Second" }))).response;
  assert.equal(failed.type, "uncertain", "A failed mutation cannot be treated as proof of no effect");
  const status = (await f.host.execute(request({ type: "status" }))).response;
  assert.ok(status.type === "ready");
  assert.equal(status.tabs.length, 1, JSON.stringify({ status, nativePaths: (await f.client.pages()).map(page => new URL(page.url).pathname) }));
  const retained = (await f.host.execute(request({ type: "retain_tab", tab_id: tab.id }))).response;
  assert.ok(retained.type === "ready"); assert.equal(retained.tabs.length, 0);
  const released = (await f.host.execute(request({ type: "release" }))).response;
  assert.ok(released.type === "closed");
  assert.ok((await f.client.pages()).some(page => page.url === `${f.origin}/done`));
});

test("MCP loss during cleanup stays uncertain and preserves the unconfirmed native page", { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), request = requests();
  const opened = (await f.host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
  assert.ok(opened.type === "ready"); const tab = opened.tabs[0]; assert.ok(tab);
  const paused = await f.pauseMcp();
  try {
    const operation = request({ type: "release" });
    const pending = f.host.execute(operation);
    await setImmediate(); // Let cleanup dispatch into the paused, exact owned provider.
    paused.kill();
    assert.equal((await within(pending, 15_000, "Lost cleanup did not settle")).response.type, "uncertain");
    assert.equal((await f.host.execute(operation)).response.type, "failed", "Cleanup is never replayed automatically");
    assert.ok((await f.client.pages()).some(page => page.url === tab.url), "An emulated Page close on disconnect is not a native close receipt");
    await f.assertUnrelatedGroup();
  } finally { paused.kill(); }
});

test("concurrent browser connections keep form input, tab ownership and cleanup separate", { skip: skipChrome, timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const broker = await f.nativeBroker();
  const owners = [
    { host: broker, request: requests(), name: "Alpha owner", choice: "First", key: "alpha" },
    { host: broker, request: requests(), name: "Beta owner", choice: "Second", key: "beta" },
  ];
  const opened = await Promise.all(owners.map(async owner => {
    const url = `${f.origin}/form?owner=${owner.key}`;
    const response = (await owner.host.execute(owner.request({ type: "open", url }))).response;
    assert.ok(response.type === "ready", JSON.stringify(response)); assert.equal(response.is_error, false);
    assert.equal(response.tabs.length, 1); const tab = response.tabs[0]; assert.ok(tab);
    assert.equal(tab.url, url);
    return { ...owner, tab, output: response.output };
  }));
  const filled = await Promise.all(opened.map(async owner => {
    const response = (await owner.host.execute(owner.request({ type: "fill", tab_id: owner.tab.id,
      element_ref: elementRef(owner.output, "textbox", "Name"), value: owner.name }))).response;
    assert.ok(response.type === "ready", JSON.stringify(response)); assert.equal(response.is_error, false);
    return { ...owner, output: response.output };
  }));
  const selected = await Promise.all(filled.map(async owner => {
    const response = (await owner.host.execute(owner.request({ type: "fill", tab_id: owner.tab.id,
      element_ref: elementRef(owner.output, "combobox", "Choice"), value: owner.choice }))).response;
    assert.ok(response.type === "ready", JSON.stringify(response)); assert.equal(response.is_error, false);
    return { ...owner, output: response.output };
  }));
  const save = async (owner: typeof selected[number]) => {
    const response = (await owner.host.execute(owner.request({ type: "click", tab_id: owner.tab.id,
      element_ref: elementRef(owner.output, "button", "Save") }))).response;
    assert.ok(response.type === "ready", JSON.stringify({ response, submitted: f.submittedForms() })); assert.equal(response.is_error, false);
    assert.deepEqual(response.tabs, [{ ...owner.tab, url: `${f.origin}/done?owner=${owner.key}`, title: "Saved form" }]);
    return owner;
  };
  const alpha = selected[0], beta = selected[1]; assert.ok(alpha && beta);
  await f.client.activate(`${f.origin}/unrelated`);
  const alphaSave = save(alpha); void alphaSave.catch(() => {});
  let saved: typeof selected;
  try {
    // Alpha is awaiting a real server response when Beta's simultaneous native
    // click arrives. The calls overlap; only the host may serialize their input.
    await f.waitForActiveTab(alpha.tab.url);
    const both = Promise.all([alphaSave, save(beta)]); void both.catch(() => {});
    await setTimeout(1000); f.finishValidation();
    saved = await both;
  } finally { f.finishValidation(); }
  assert.equal(f.count(), 2);
  const submitted = new Map(f.submittedForms().map(form => [form.path, new URLSearchParams(form.body)]));
  assert.equal(submitted.size, 2);
  for (const owner of owners) {
    const form = submitted.get(`/submit?owner=${owner.key}`); assert.ok(form);
    assert.equal(form.get("name"), owner.name, "Each native form must submit its own owner's input");
    assert.equal(form.get("choice"), owner.choice);
  }

  const first = saved[0], second = saved[1]; assert.ok(first && second);
  const released = (await first.host.execute(first.request({ type: "release" }))).response;
  assert.ok(released.type === "closed", JSON.stringify(released)); assert.equal(released.tabs.length, 0);
  const status = (await second.host.execute(second.request({ type: "status" }))).response;
  assert.ok(status.type === "ready", JSON.stringify(status)); assert.equal(status.is_error, false);
  assert.deepEqual(status.tabs, [{ ...second.tab, url: `${f.origin}/done?owner=${second.key}`, title: "Saved form" }]);
  const snapshot = (await second.host.execute(second.request({ type: "snapshot", tab_id: second.tab.id }))).response;
  assert.ok(snapshot.type === "ready", JSON.stringify(snapshot)); assert.equal(snapshot.is_error, false);
  assert.ok(snapshot.output.includes("Saved"));
  const pages = await f.client.pages();
  assert.equal(pages.some(page => page.url === `${f.origin}/done?owner=${first.key}`), false);
  assert.ok(pages.some(page => page.url === `${f.origin}/done?owner=${second.key}`));
  assert.ok(pages.some(page => page.url === `${f.origin}/unrelated`));
  const secondRelease = (await second.host.execute(second.request({ type: "release" }))).response;
  assert.ok(secondRelease.type === "closed", JSON.stringify(secondRelease)); assert.equal(secondRelease.tabs.length, 0);
  assert.ok((await f.client.pages()).some(page => page.url === `${f.origin}/unrelated`));
  await f.assertUnrelatedGroup();
  assert.equal(f.browser.exitCode, null, "Releasing either connection must preserve the shared Chrome instance");
});

test("run_code uses the real Page API for dialogs, frames and owned tab lifecycle", { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), host = await f.nativeBroker(), request = requests("1");
  const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form?phase=run-code` }))).response;
  assert.ok(opened.type === "ready"); const tab = opened.tabs[0]; assert.ok(tab);
  const operation = request({ type: "run_code", tab_id: tab.id, code: `async page => {
    await page.bringToFront();
    console.log('script started');
    page.once('dialog', async dialog => { await dialog.accept(); });
    await page.getByRole('button', {name:'Open dialog', exact:true}).click();
    await page.evaluate(() => {
      const frame = document.createElement('iframe'); frame.title = 'Script frame'; frame.src = '/embedded'; document.body.append(frame);
    });
    const note = page.frameLocator('iframe[title="Script frame"]').getByRole('textbox', {name:'Frame note'});
    await note.fill('Inside the frame'); const frameValue = await note.inputValue();
    await page.getByRole('textbox', {name:'Name', exact:true}).fill('Scripted owner');
    await page.getByRole('combobox', {name:'Choice'}).selectOption({label:'Second'});
    await page.getByRole('button', {name:'Save', exact:true}).click();
    const child = await page.context().newPage();
    await child.goto(new URL('/form?phase=script-child', page.url()).href);
    child.once('dialog', async dialog => { await dialog.dismiss(); });
    await child.getByRole('button', {name:'Open dialog', exact:true}).click();
    const childUrl = child.url();
    console.log('script submitted');
    return {url:page.url(), frameValue, childUrl};
  }` });
  const completed = (await host.execute(operation)).response;
  assert.ok(completed.type === "ready", JSON.stringify(completed)); assert.equal(completed.is_error, false);
  assert.equal(completed.tabs.length, 2); assert.ok(completed.tabs.some(current => current.id === tab.id));
  const successor = completed.tabs.find(current => current.url === `${f.origin}/form?phase=script-child`); assert.ok(successor);
  assert.notEqual(successor.id, tab.id);
  const output: unknown = JSON.parse(completed.output); assert.ok(object(output));
  assert.deepEqual(output.result, { url: `${f.origin}/done?phase=run-code`, frameValue: "Inside the frame", childUrl: `${f.origin}/form?phase=script-child` });
  assert.deepEqual(output.logs, ["script started", "script submitted"]);
  assert.equal(f.count(), 1);
  const form = new URLSearchParams(f.submittedBodies()[0]);
  assert.equal(form.get("name"), "Scripted owner"); assert.equal(form.get("choice"), "Second");
  assert.equal((await host.execute(operation)).response.type, "failed"); assert.equal(f.count(), 1);
  assert.ok((await f.client.pages()).some(page => page.url === `${f.origin}/form?phase=script-child`));
  const released = (await host.execute(request({ type: "release" }))).response;
  assert.ok(released.type === "closed", JSON.stringify(released)); assert.equal(released.tabs.length, 0);
  const pages = await f.client.pages();
  assert.equal(pages.some(page => page.url === `${f.origin}/done?phase=run-code` || page.url === successor.url), false);
  assert.ok(pages.some(page => page.url === `${f.origin}/unrelated`));
  await f.assertUnrelatedGroup(); assert.equal(f.browser.exitCode, null);
});

test("unconfigured pairing reports a fixed stage without exposing the supplied credential", async () => {
  const credential = "invalid-private-credential";
  const host = new BrowserHost({ user_data_dir: null, profile_dir_name: null }, { extensionToken: credential });
  const reply = (await host.execute(requests()({ type: "open", url: "about:blank" }))).response;
  assert.ok(reply.type === "uncertain");
  assert.match(reply.message, /Connection stage: pairing/);
  assert.equal(JSON.stringify(reply).includes(credential), false);
  await host.close();
});

test("run_code raw Page.close keeps its actual effect uncertain until native cleanup is known", { skip: skipChrome, timeout: 60_000 }, async t => {
  const f = await fixture(t), host = await f.nativeBroker(), request = requests();
  const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form?phase=raw-close` }))).response;
  assert.ok(opened.type === "ready"); const tab = opened.tabs[0]; assert.ok(tab);
  const operation = request({ type: "run_code", tab_id: tab.id, code: "async page => { await page.close({runBeforeUnload:true}); return 'closed'; }" });
  const closed = (await host.execute(operation)).response;
  assert.ok(closed.type === "uncertain");
  assert.match(closed.message, /Control lost: (owned_page_closed|browser_disconnected|mcp_closed)/);
  assert.equal((await host.execute(operation)).response.type, "failed", "An uncertain script cannot be replayed");
  assert.equal((await f.client.pages()).some(page => page.url === tab.url), false, "The real Page.close effect must still occur");
  assert.equal((await host.execute(request({ type: "status" }))).response.type, "disconnected");
  await f.assertUnrelatedGroup(); assert.equal(f.browser.exitCode, null);
});

test("run_code redacts pairing tokens before result and error truncation and from native tab metadata", { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), host = await f.nativeBroker(), request = requests();
  const opened = (await host.execute(request({ type: "open", url: "about:blank" }))).response;
  assert.ok(opened.type === "ready"); const tab = opened.tabs[0]; assert.ok(tab);
  const run = async (code: string) => (await host.execute(request({ type: "run_code", tab_id: tab.id, code }))).response;
  const payloadLength = (text: string) => { const match = text.match(/x{32,}/); assert.ok(match); return match[0].length; };
  // Measure the public producer's actual cutoff with safe data, then straddle it
  // with this disposable profile's synthetic token. No token enters a receipt.
  const probe = await run("async () => 'x'.repeat(70000)"); assert.ok(probe.type === "ready");
  const resultPadding = payloadLength(probe.output) - Math.ceil(f.pairingToken.length / 2);
  const result = await run(`async () => 'x'.repeat(${resultPadding}) + ${JSON.stringify(f.pairingToken)} + 'x'.repeat(70000)`);
  assert.ok(result.type === "ready"); f.assertNoBootstrapDetails(result);
  assert.ok(result.output.includes("[redacted]")); assert.ok(result.output.length <= 65536);

  const errorProbe = await run("async () => { throw new Error('x'.repeat(10000)); }"); assert.ok(errorProbe.type === "uncertain");
  assert.equal((await host.execute(request({ type: "status" }))).response.type, "ready");
  const errorPadding = payloadLength(errorProbe.message) - Math.ceil(f.pairingToken.length / 2);
  const error = await run(`async () => { throw new Error('x'.repeat(${errorPadding}) + ${JSON.stringify(f.pairingToken)} + 'x'.repeat(10000)); }`);
  assert.ok(error.type === "uncertain"); f.assertNoBootstrapDetails(error);
  assert.ok(error.message.includes("[redacted]"));
  const status = (await host.execute(request({ type: "status" }))).response; assert.ok(status.type === "ready");

  const metadata = await run(`async page => { await page.goto(${JSON.stringify(`${f.origin}/redaction?synthetic=${f.pairingToken}`)}); await page.evaluate(value => { document.title = value; }, ${JSON.stringify(f.pairingToken)}); return 'metadata'; }`);
  assert.ok(metadata.type === "ready"); f.assertNoBootstrapDetails(metadata);
  assert.ok(metadata.tabs[0]?.url.includes("[redacted]")); assert.equal(metadata.tabs[0]?.title === "[redacted]", true);
  const released = (await host.execute(request({ type: "release" }))).response;
  assert.ok(released.type === "closed"); await f.assertUnrelatedGroup();
});

test("unattended extension pairing survives helper and Chrome restarts without consent interactions", { skip: skipChrome, timeout: 180_000 }, async t => {
  const f = await fixture(t), owner = randomUUID(), initialRequest = requests(owner);
  const initial = (await within(f.host.execute(initialRequest({ type: "open", url: `${f.origin}/form?phase=initial` })), 45_000,
    "Initial unattended extension connection did not finish")).response;
  assert.ok(initial.type === "ready", JSON.stringify(initial)); assert.equal(initial.is_error, false);
  assert.ok(initial.output.includes("Form ready")); f.assertNoBootstrapDetails(initial);
  const original = initial.tabs[0]; assert.ok(original);
  const drafted = (await f.host.execute(initialRequest({ type: "fill", tab_id: original.id,
    element_ref: elementRef(initial.output, "textbox", "Name"), value: "Synthetic draft" }))).response;
  assert.ok(drafted.type === "ready"); assert.equal(drafted.is_error, false);
  await f.host.close();
  assert.equal((await f.host.execute(initialRequest({ type: "status" }))).response.type, "disconnected");
  assert.equal((await f.client.nativeState(original.url)).value, "Synthetic draft", "Cold helper shutdown must preserve the user's native page state");

  const replacement = f.newHost(), replacementRequest = requests(owner);
  const reconnected = (await within(replacement.execute(replacementRequest({ type: "open", url: `${f.origin}/form?phase=helper-restart` })), 45_000,
    "Fresh helper did not pair automatically with the existing token")).response;
  assert.ok(reconnected.type === "ready", JSON.stringify(reconnected)); assert.equal(reconnected.is_error, false);
  assert.ok(reconnected.output.includes("Form ready")); f.assertNoBootstrapDetails(reconnected);
  const replaced = reconnected.tabs[0]; assert.ok(replaced);
  assert.equal((await replacement.execute(initialRequest({ type: "snapshot", tab_id: original.id }))).response.type, "failed",
    "An old session handle cannot address a fresh helper's local tab ID");
  assert.ok((await f.client.pages()).some(page => page.url === original.url));
  await f.assertUnrelatedGroup();

  await f.restartBrowser();
  const oldState = (await replacement.execute(replacementRequest({ type: "status" }))).response;
  assert.equal(oldState.type, "disconnected", "Browser restart invalidates every old native Page handle");
  assert.equal((await replacement.execute(replacementRequest({ type: "snapshot", tab_id: replaced.id }))).response.type, "disconnected");
  const afterRestart = f.newHost(), afterRestartRequest = requests(owner);
  const reopened = (await within(afterRestart.execute(afterRestartRequest({ type: "open", url: `${f.origin}/form?phase=chrome-restart` })), 45_000,
    "Chrome restart required another consent interaction")).response;
  assert.ok(reopened.type === "ready", JSON.stringify(reopened)); assert.equal(reopened.is_error, false);
  assert.ok(reopened.output.includes("Form ready"), "The existing signed-in profile must survive a full Chrome restart");
  f.assertNoBootstrapDetails(reopened);
  const fresh = reopened.tabs[0]; assert.ok(fresh);
  const filled = (await afterRestart.execute(afterRestartRequest({ type: "fill", tab_id: fresh.id,
    element_ref: elementRef(reopened.output, "textbox", "Name"), value: "After browser restart" }))).response;
  assert.ok(filled.type === "ready"); assert.equal(filled.is_error, false);
  const saved = (await afterRestart.execute(afterRestartRequest({ type: "click", tab_id: fresh.id,
    element_ref: elementRef(filled.output, "button", "Save") }))).response;
  assert.ok(saved.type === "ready", JSON.stringify(saved)); assert.equal(saved.is_error, false);
  assert.equal(f.count(), 1);
  assert.equal(new URLSearchParams(f.submittedBodies()[0]).get("name"), "After browser restart");
  const released = (await afterRestart.execute(afterRestartRequest({ type: "release" }))).response;
  assert.ok(released.type === "closed", JSON.stringify(released)); assert.equal(released.tabs.length, 0);
});

test("direct input activates only its owned native page while snapshots stay in the background", { skip: skipChrome, timeout: 120_000 }, async t => {
  const actions: ("snapshot" | "fill" | "click" | "press_key")[] = ["snapshot", "fill", "click", "press_key"];
  for (const type of actions) await t.test(type, async t => {
    const f = await fixture(t), request = requests();
    const opened = (await f.host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
    assert.ok(opened.type === "ready", JSON.stringify(opened)); assert.equal(opened.is_error, false);
    const tab = opened.tabs[0]; assert.ok(tab);
    await f.client.activate(`${f.origin}/unrelated`);
    let action: BrowserAction;
    switch (type) {
      case "snapshot": action = { type, tab_id: tab.id }; break;
      case "fill": action = { type, tab_id: tab.id, element_ref: elementRef(opened.output, "textbox", "Name"), value: "Synthetic user" }; break;
      case "click": action = { type, tab_id: tab.id, element_ref: elementRef(opened.output, "textbox", "Name") }; break;
      case "press_key": action = { type, tab_id: tab.id, key: "Tab" }; break;
    }
    const result = (await f.host.execute(request(action))).response;
    assert.ok(result.type === "ready", JSON.stringify(result)); assert.equal(result.is_error, false);
    // Inspect the native page independently after the tested connection disconnects.
    await f.host.close();
    const state = await f.client.nativeState(`${f.origin}/form`);
    assert.equal(state.visible, type === "snapshot" ? "hidden" : "visible");
    assert.equal(state.focused, type !== "snapshot");
    assert.equal(state.value, type === "fill" ? "Synthetic user" : "");
    assert.equal(state.active, type === "snapshot" ? null : "name");
    assert.ok((await f.client.pages()).some(page => page.url === `${f.origin}/unrelated`));
  });
});

test("lost browser transport leaves a submitted mutation uncertain without replaying or closing its tab", { skip: skipChrome, timeout: 60_000 }, async t => {
  const f = await fixture(t, { slowSubmit: true }), host = f.host, request = requests();
  const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
  assert.ok(opened.type === "ready", JSON.stringify(opened)); const tab = opened.tabs[0]; assert.ok(tab);
  const native = (await f.client.pages()).find(page => page.url === tab.url); assert.ok(native);
  const operation = request({ type: "click", tab_id: tab.id, element_ref: elementRef(opened.output, "button", "Save") });
  const pending = host.execute(operation);
  await Promise.race([f.submitted, setTimeout(15_000, undefined, { ref: false }).then(() => { throw new Error("Fixture submission did not arrive"); })]);
  assert.equal(f.count(), 1); await host.close();
  assert.equal((await pending).response.type, "uncertain");
  assert.equal((await host.execute(operation)).response.type, "failed"); assert.equal(f.count(), 1);
  f.finishSubmission();
  assert.equal((await host.execute(request({ type: "snapshot", tab_id: tab.id }))).response.type, "disconnected");
  // Releasing the response starts a redirect; it does not confirm its commit.
  // Observe that completion on the same native target, rather than inferring
  // tab closure from a transient navigation URL or matching another form.
  const controller = new AbortController();
  try {
    const pages = await within((async () => {
      for (;;) {
        const pages = await f.client.pages();
        if (pages.some(page => page.targetId === native.targetId && page.url === `${f.origin}/done`)) return pages;
        await setTimeout(10, undefined, { signal: controller.signal });
      }
    })(), 5000, "The same submitted native tab must survive transport loss and finish its redirect");
    assert.ok(pages.some(page => page.targetId === native.targetId && page.url === `${f.origin}/done`), JSON.stringify({ targetId: native.targetId, pages }));
  } finally { controller.abort(); }
  assert.equal(f.browser.exitCode, null);
});

test("foreign extension iframe detach never masquerades as completed native tab cleanup", { skip: skipChrome, timeout: 60_000 }, async t => {
  const f = await fixture(t, { foreignFrame: true }), request = requests();
  const opened = (await f.host.execute(request({ type: "open", url: `${f.origin}/form?phase=detached` }))).response;
  assert.ok(opened.type === "ready"); const tab = opened.tabs[0]; assert.ok(tab);
  const companion = (await f.host.execute(request({ type: "new_tab", url: `${f.origin}/form?phase=companion` }))).response;
  assert.ok(companion.type === "ready"); assert.equal(companion.tabs.length, 2);
  await f.host.execute(request({ type: "fill", tab_id: tab.id, element_ref: elementRef(opened.output, "textbox", "Name"), value: "Synthetic input" }));
  const status = await within((async () => {
    for (;;) {
      const response = (await f.host.execute(request({ type: "status" }))).response;
      if (response.type !== "ready" || !response.tabs.some(current => current.id === tab.id)) return response;
      await setTimeout(10);
    }
  })(), 5000, "The detached native page must invalidate its adapter handle");
  const released = (await f.host.execute(request({ type: "release" }))).response;
  assert.ok((await f.client.pages()).some(page => page.url === tab.url), "Debugger detach must not be mistaken for native tab closure");
  assert.equal(status.type, "disconnected", JSON.stringify({ status, released }));
  assert.ok(released.type === "disconnected", JSON.stringify(released));
  assert.match(released.message, /cleanup.*not verified/i);
  assert.match(released.message, /Control lost: (owned_page_closed|browser_disconnected|mcp_closed)/);
  await f.host.close();
  assert.ok((await f.client.pages()).some(page => page.url === tab.url));
  await f.assertUnrelatedGroup();
  assert.equal(f.browser.exitCode, null);
});

test("release reports final-page closure from native readback, including any retained page", { skip: skipChrome, timeout: 60_000 }, async t => {
  const f = await fixture(t), host = f.host, request = requests();
  const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
  assert.ok(opened.type === "ready", JSON.stringify(opened)); const tab = opened.tabs[0]; assert.ok(tab);
  for (const page of await f.client.pages()) if (page.url !== tab.url) await f.client.call("Target.closeTarget", { targetId: page.targetId });
  const released = (await host.execute(request({ type: "release" }))).response;
  assert.ok(released.type === "closed", JSON.stringify(released));
  const remaining = (await f.client.pages()).filter(page => page.url === tab.url);
  assert.equal(released.tabs.length, remaining.length, "The receipt must agree with independent native readback, whether the final-page guard retained it or closure completed");
  if (remaining.length > 0) assert.equal(released.tabs[0]?.id, tab.id);
  await host.close();
  assert.equal(f.browser.exitCode, null);
});

test("password capture redacts real snapshots, scripts, logs, errors and URLs before escaping and truncation",
  { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), host = f.host, request = requests("1");
  const opened = (await host.execute(request({ type: "open", url: f.origin + "/password" }))).response;
  assert.ok(opened.type === "ready", JSON.stringify(opened)); const tab = opened.tabs[0]; assert.ok(tab);
  const values = { password: "SYNTHETIC_PASSWORD_MAIN-\"'\\<&?=+%☃", framed: "[redacted]SYNTHETIC_PASSWORD_FRAME-\"'\\<&?=+%☃",
    later: "SYNTHETIC_PASSWORD_LATER-\"'\\<&?=+%☃" };
  const privateOutput = (value: unknown) => assert.equal(JSON.stringify(value).includes("SYNTHETIC_PASSWORD_"), false,
    "No raw, escaped, URL-encoded or truncated password prefix may enter a browser reply");
  const run = async (fn: (page: Page, args: typeof values) => Promise<unknown>) =>
    (await host.execute(request({ type: "run_code", tab_id: tab.id,
      code: "async page => (" + fn.toString() + ")(page," + JSON.stringify(values) + ")" }))).response;
  const filled = await run(async (page, values) => {
    await page.getByLabel("Password", { exact: true }).fill(values.password);
    await page.frameLocator('iframe[title="Password frame"]').getByLabel("Frame password").fill(values.framed);
    console.log(values.password, { password: values.password }, JSON.stringify(values.password), encodeURIComponent(values.password));
    return { password: values.password, framed: values.framed, normal: await page.getByLabel("Normal field").inputValue() };
  });
  assert.ok(filled.type === "ready", JSON.stringify(filled)); privateOutput(filled);
  assert.ok(filled.output.includes("Visible normal field")); assert.ok(filled.output.includes("[redacted]"));
  const snapshot = (await host.execute(request({ type: "snapshot", tab_id: tab.id }))).response;
  assert.ok(snapshot.type === "ready"); privateOutput(snapshot); assert.ok(snapshot.output.includes("Visible normal field"));
  const modal = (await host.execute(request({ type: "click", tab_id: tab.id,
    element_ref: elementRef(snapshot.output, "button", "Clear password into dialog") }))).response;
  assert.ok(modal.type === "ready", JSON.stringify(modal)); privateOutput(modal);
  const modalOutput: unknown = JSON.parse(modal.output);
  assert.ok(object(modalOutput) && object(modalOutput.dialog));
  assert.equal(modalOutput.dialog.message, "[redacted]"); assert.equal(modalOutput.dialog.defaultValue, "[redacted]");
  const dismissed = (await host.execute(request({ type: "handle_dialog", tab_id: tab.id, accept: false, prompt_text: null }))).response;
  assert.ok(dismissed.type === "ready"); privateOutput(dismissed);
  const navigated = await run(async (page, values) => {
    await page.getByLabel("Password", { exact: true }).fill(values.later);
    const captured = await page.getByLabel("Password", { exact: true }).inputValue();
    await page.getByLabel("Password", { exact: true }).fill("");
    console.log({ captured });
    const target = new URL("/redaction", page.url()); target.searchParams.set("value", captured);
    await page.goto(target.href); await page.evaluate(value => { document.title = value; }, captured);
    return { captured, escaped: JSON.stringify(captured), encoded: encodeURIComponent(captured) };
  });
  assert.ok(navigated.type === "ready", JSON.stringify(navigated)); privateOutput(navigated);
  assert.ok(navigated.tabs[0]?.url.includes("[redacted]")); assert.equal(navigated.tabs[0]?.title, "[redacted]");
  const large = await run(async (_page, values) => { console.log("x".repeat(65520) + values.later); return values.later; });
  assert.ok(large.type === "ready"); privateOutput(large); assert.ok(large.output.length <= 65536);
  const failed = await run(async (page, values) => {
    await page.goto(new URL("/password", page.url()).href);
    const secret = "SYNTHETIC_PASSWORD_ERROR-" + values.password;
    await page.getByLabel("Password", { exact: true }).fill(secret);
    await page.getByLabel("Password", { exact: true }).fill("");
    await page.goto(new URL("/retained", page.url()).href);
    throw new Error("x".repeat(8160) + JSON.stringify(secret));
  });
  assert.ok(failed.type === "uncertain", JSON.stringify(failed)); privateOutput(failed);
  const withheld = "Failure stage: browser_operation. Browser output was withheld because password capture could not be verified. "
    + "Earlier effects were not replayed; inspect Chrome before continuing.";
  assert.ok(failed.message.includes("[redacted]") || failed.message === withheld, JSON.stringify(failed));
  const released = (await host.execute(request({ type: "release" }))).response;
  assert.ok(released.type === "closed", JSON.stringify(released)); privateOutput(released);
});

test("unverifiable bounded password capture withholds script output and still permits exact owned cleanup",
  { skip: skipChrome, timeout: 60_000 }, async t => {
  const f = await fixture(t), request = requests("1");
  const opened = (await f.host.execute(request({ type: "open", url: f.origin + "/password" }))).response;
  assert.ok(opened.type === "ready", JSON.stringify(opened)); const tab = opened.tabs[0]; assert.ok(tab);
  const failed = (await f.host.execute(request({ type: "run_code", tab_id: tab.id,
    code: 'async page => { const value="SYNTHETIC_PASSWORD_OVERSIZED_"+"q".repeat(9000); await page.getByLabel("Password",{exact:true}).fill(value); console.log(value); return value; }' }))).response;
  assert.ok(failed.type === "uncertain", JSON.stringify(failed)); assert.match(failed.message, /output was withheld.*password capture/);
  assert.equal(JSON.stringify(failed).includes("SYNTHETIC_PASSWORD_"), false);
  const released = (await f.host.execute(request({ type: "release" }))).response;
  assert.ok(released.type === "closed", JSON.stringify(released));
  assert.equal((await f.client.pages()).some(page => page.url === tab.url), false); assert.equal(f.browser.exitCode, null);
});

test("document-start clears and ordinary blank or srcdoc frames never expose filled passwords",
  { skip: skipChrome, timeout: 90_000 }, async t => {
  const f = await fixture(t), request = requests();
  const opened = (await f.host.execute(request({ type: "open", url: f.origin + "/inline-password" }))).response;
  assert.ok(opened.type === "ready", JSON.stringify(opened));
  assert.equal(JSON.stringify(opened).includes("SYNTHETIC_INLINE_PASSWORD_42"), false);
  assert.ok(opened.output.includes("[redacted]"));
  const tab = opened.tabs[0]; assert.ok(tab);
  const filled = (await f.host.execute(request({ type: "run_code", tab_id: tab.id, code: `async page => {
    const child = await page.context().newPage();
    await child.setContent('<label>Blank password<input type="password"></label>');
    await child.getByLabel('Blank password').fill('SYNTHETIC_BLANK_PASSWORD_42');
    const blank = await child.getByLabel('Blank password').inputValue();
    await child.getByLabel('Blank password').fill('');
    await page.evaluate(() => {
      const frame = document.createElement('iframe'); frame.title = 'Inline frame';
      frame.srcdoc = '<label>Frame password<input type="password"></label>'; document.body.append(frame);
    });
    const field = page.frameLocator('iframe[title="Inline frame"]').getByLabel('Frame password');
    await field.fill('SYNTHETIC_SRCDOC_PASSWORD_42');
    return { blank, srcdoc: await field.inputValue() };
  }` }))).response;
  assert.ok(filled.type === "ready", JSON.stringify(filled));
  assert.equal(JSON.stringify(filled).includes("SYNTHETIC_"), false);
  const result: unknown = JSON.parse(filled.output);
  assert.ok(object(result) && object(result.result));
  assert.deepEqual(result.result, { blank: "[redacted]", srcdoc: "[redacted]" });
  const failed = (await f.host.execute(request({ type: "run_code", tab_id: tab.id, code: `async page => {
    await page.evaluate(() => {
      const input = document.querySelector('input'); if (!input) throw new Error('Missing password');
      input.value = 'SYNTHETIC_IMMEDIATE_ERROR_42'; const value = input.value; input.value = ''; throw new Error(value);
    });
  }` }))).response;
  assert.ok(failed.type === "uncertain", JSON.stringify(failed));
  assert.equal(failed.message.includes("SYNTHETIC_"), false);
  const released = (await f.host.execute(request({ type: "release" }))).response;
  assert.equal(released.type, "closed", JSON.stringify(released));
  assert.ok((await f.client.pages()).some(page => page.url === f.origin + "/unrelated"));
});
