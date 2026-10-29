import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import type { BrowserAction } from "../src/generated/BrowserAction.js";
import type { BrowserReply } from "../src/generated/BrowserReply.js";
import type { BrowserRequest } from "../src/generated/BrowserRequest.js";

const chrome = process.env.AGENT_TEST_CHROME;
const skip = chrome === undefined && process.env.CI !== "true";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(value: unknown): value is BrowserReply {
  if (!object(value) || typeof value.operation_id !== "string" || !object(value.response)) return false;
  const response = value.response;
  if (typeof response.session_id !== "string") return false;
  if (["failed", "disconnected", "uncertain"].includes(String(response.type))) return typeof response.message === "string";
  return (response.type === "closed" || response.type === "ready" && typeof response.is_error === "boolean")
    && typeof response.output === "string" && Array.isArray(response.tabs)
    && response.tabs.every((tab: unknown) => object(tab) && typeof tab.id === "number"
      && typeof tab.url === "string" && typeof tab.title === "string");
}

/** Exercises the shipped helper entry point and its actual configuration consumer. */
class NativeHelper {
  private readonly child;
  private readonly exited: Promise<void>;
  private readonly lines;
  constructor(port: number) {
    this.child = spawn(process.execPath, [fileURLToPath(new URL("../src/browser-host.js", import.meta.url)),
      JSON.stringify({ user_data_dir: null, profile_dir_name: null, debugging_port: port })],
      { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: "" } });
    this.exited = new Promise(resolve => this.child.once("close", () => resolve()));
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  }
  async execute(request: BrowserRequest): Promise<BrowserReply> {
    this.child.stdin.write(JSON.stringify(request) + "\n");
    const timer = new AbortController();
    try {
      const line = await Promise.race([this.lines.next(), setTimeout(35_000, undefined, { signal: timer.signal })
        .then(() => { throw new Error("Native helper did not confirm its request"); })]);
      assert.equal(line.done, false);
      const value: unknown = JSON.parse(line.value);
      assert.ok(reply(value));
      assert.equal(value.operation_id, request.operation_id);
      assert.equal(value.response.session_id, request.session_id);
      return value;
    } finally { timer.abort(); }
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    if (await Promise.race([this.exited.then(() => true), setTimeout(5000, false)])) return;
    this.child.kill("SIGTERM");
    if (await Promise.race([this.exited.then(() => true), setTimeout(5000, false)])) return;
    this.child.kill("SIGKILL"); await this.exited;
  }
}

test("native CDP keeps normal Playwright control with a foreign extension frame and closes only owned tabs",
  { skip, timeout: 45_000 }, async t => {
  assert.ok(chrome, "AGENT_TEST_CHROME must select an explicit disposable test binary");
  const directory = await mkdtemp(join(tmpdir(), "agent-native-cdp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, "inline-menu"); await mkdir(extension);
  await writeFile(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3,
    name: "Invented inline menu", version: "1.0",
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["inject.js"], run_at: "document_start" }],
    web_accessible_resources: [{ resources: ["menu.html"], matches: ["http://127.0.0.1/*"] }] }));
  await writeFile(join(extension, "menu.html"), "<!doctype html><p>Invented extension menu</p>");
  await writeFile(join(extension, "inject.js"), `let inserted = false;
document.addEventListener('focusin', event => {
  if (inserted || !(event.target instanceof HTMLInputElement)) return;
  inserted = true;
  const host = document.createElement('fixture-inline-menu');
  const frame = document.createElement('iframe'); frame.src = chrome.runtime.getURL('menu.html');
  host.attachShadow({mode:'closed'}).append(frame); document.documentElement.append(host);
});`);
  const inventedPassword = "Invented-native-password-42";
  const credentialCli = join(directory, "credential-cli.mjs");
  await writeFile(credentialCli, "import assert from 'node:assert/strict';\n"
    + "assert.deepEqual(process.argv.slice(2), ['item','get','invented-login','--format','json']);\n"
    + "process.stdout.write(" + JSON.stringify(JSON.stringify({ fields: [
      { id: "username", value: "Native form value" }, { id: "password", value: inventedPassword }
    ] })) + ");");
  let submissions = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/seed") {
      response.setHeader("Set-Cookie", "synthetic_login=present; HttpOnly; Path=/; SameSite=Lax");
      response.end("<!doctype html><h1>User tab sentinel</h1>");
    } else if (request.url === "/login") {
      if (!request.headers.cookie?.includes("synthetic_login=present")) { response.writeHead(401).end("Missing login"); return; }
      response.end(`<!doctype html><title>Owned login</title><form method="post" action="/submit" target="result">
        <label>Name<input name="name"></label><label>Password<input type="password" name="password"></label>
        <button>Save</button></form><iframe name="result" title="Result" src="/frame"></iframe>`);
    } else if (request.url === "/frame") {
      response.end('<!doctype html><label>Frame note<input name="note"></label>');
    } else if (request.url === "/submit") {
      let body = "";
      request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("name") !== "Native form value" || form.get("password") !== inventedPassword) {
          response.writeHead(400).end("Unexpected fixture form"); return;
        }
        submissions++;
        response.end("<!doctype html><h1>Saved</h1>");
      });
    } else response.end("<!doctype html><h1>Unrelated page</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = join(directory, "profile");
  const args = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--headless=new",
    `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, "--use-mock-keychain",
    "--password-store=basic", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "about:blank"];
  if (process.platform === "linux" || process.getuid?.() === 0) args.unshift("--no-sandbox");
  const processChrome = spawn(chrome, args, { stdio: "ignore" });
  const exited = new Promise<void>(resolve => processChrome.once("close", () => resolve()));
  let observer: Browser | undefined;
  const hosts: NativeHelper[] = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    await observer?.close();
    if (processChrome.exitCode === null && processChrome.signalCode === null) {
      processChrome.kill("SIGTERM");
      const stopped = await Promise.race([exited.then(() => true), setTimeout(5000, false)]);
      if (!stopped) { processChrome.kill("SIGKILL"); await exited; }
    }
  });
  let port = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.equal(processChrome.exitCode, null, "Disposable Chrome must remain running");
    try {
      const first = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      const parsed = Number(first);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) { port = parsed; break; }
    } catch { /* Wait only for the exact disposable profile's endpoint. */ }
    await setTimeout(50);
  }
  assert.notEqual(port, 0, "Disposable Chrome must publish its native endpoint");
  observer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 10_000 });
  const context = observer.contexts()[0]; assert.ok(context);
  const sentinel = await context.newPage(); await sentinel.goto(`${origin}/seed`);
  const initialPages = context.pages().length;
  // Separate helpers reconnect to the same browser without extension pairing.
  for (let helper = 0; helper < 2; helper++) {
    const host = new NativeHelper(port);
    hosts.push(host);
    const owner_id = randomUUID(), session_id = randomUUID();
    const execute = async (action: BrowserAction) => (await host.execute({ owner_id, session_id, operation_id: randomUUID(), action })).response;
    const opened = await execute({ type: "open", url: `${origin}/login` });
    assert.ok(opened.type === "ready", JSON.stringify(opened));
    assert.equal(opened.tabs.length, 1); const tab = opened.tabs[0]; assert.ok(tab);
    const status = await execute({ type: "status" });
    assert.ok(status.type === "ready", JSON.stringify(status));
    assert.equal(status.output.includes(inventedPassword), false);
    const filled = await execute({ type: "run_code", tab_id: tab.id, code: `async page => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { execPath } = await import('node:process');
      const { stdout } = await promisify(execFile)(execPath,
        [${JSON.stringify(credentialCli)},'item','get','invented-login','--format','json'], {timeout:5000});
      const { fields } = JSON.parse(stdout);
      const username = fields.find(field => field.id === 'username').value;
      const password = fields.find(field => field.id === 'password').value;
      const attached = page.waitForEvent('framenavigated', {predicate: frame => frame.url().startsWith('chrome-extension://'), timeout:5000});
      await page.getByLabel('Name', {exact:true}).fill(username);
      const foreign = await attached;
      if (!foreign || foreign.isDetached()) throw new Error('Foreign extension frame must remain attached');
      await page.getByLabel('Name', {exact:true}).focus();
      const ordinary = page.frameLocator('iframe[title="Result"]');
      await ordinary.getByLabel('Frame note').fill('Ordinary frame works');
      await page.getByLabel('Password', {exact:true}).fill(password);
      console.log(password);
      return { foreignFramePresent: !foreign.isDetached(), ordinaryFrameValue: await ordinary.getByLabel('Frame note').inputValue(), password };
    }` });
    assert.ok(filled.type === "ready", JSON.stringify(filled));
    assert.equal(filled.output.includes(inventedPassword), false, "A filled password must not enter tool output");
    assert.ok(filled.output.includes('"foreignFramePresent":true'));
    assert.ok(filled.output.includes("Ordinary frame works"));
    const submitted = await execute({ type: "run_code", tab_id: tab.id, code: `async page => {
      const foreign = page.frames().find(frame => frame.url().startsWith('chrome-extension://'));
      await page.getByRole('button', {name:'Save',exact:true}).click();
      await page.frameLocator('iframe[title="Result"]').getByRole('heading', {name:'Saved',exact:true}).waitFor();
      return { foreignFramePresent: !!foreign && !foreign.isDetached() };
    }` });
    assert.ok(submitted.type === "ready", JSON.stringify(submitted));
    assert.equal(submitted.output.includes(inventedPassword), false);
    assert.ok(submitted.output.includes('"foreignFramePresent":true'));
    assert.equal(submissions, helper + 1, "The real server must receive exactly one correct submission per helper");
    const released = await execute({ type: "release" });
    assert.equal(released.type, "closed", JSON.stringify(released));
    assert.equal(context.pages().length, initialPages, "Release must close every exact owned page");
    assert.equal(sentinel.isClosed(), false);
    assert.equal(processChrome.exitCode, null, "Disconnect must preserve the user's Chrome process");
    assert.equal(processChrome.signalCode, null);
  }
});
