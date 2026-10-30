import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright-core";
import type { BrowserAction } from "../src/generated/BrowserAction.js";
import type { BrowserReply } from "../src/generated/BrowserReply.js";
import type { BrowserRequest } from "../src/generated/BrowserRequest.js";

const chrome = process.env.AGENT_TEST_CHROME;
const skip = chrome === undefined && process.env.CI !== "true";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function groupAlive(group: number): Promise<boolean> {
  try { process.kill(-group, 0); return true; }
  catch (error) {
    if (object(error) && error.code === "ESRCH") return false;
    if (!object(error) || error.code !== "EPERM") throw error;
    // Darwin's killpg filters zombies and returns EPERM when none remain
    // signalable. Prove that this exact owned group has no live writers rather
    // than treating every permission failure as successful cleanup.
    const { stdout } = await promisify(execFile)("/bin/ps", ["-ax", "-o", "pgid=,stat="]);
    for (const line of stdout.split("\n").filter(line => line.trim() !== "")) {
      const fields = line.trim().split(/\s+/);
      assert.ok(fields.length === 2 && /^\d+$/.test(fields[0]!), "Native group inspection must provide group and state");
      if (fields[0] === String(group) && !fields[1]!.startsWith("Z")) throw error;
    }
    return false;
  }
}

test("owned Chrome group cleanup recognizes exited native children before their parent reaps them", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", detached: true });
  const exited = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  const group = child.pid; assert.ok(group !== undefined && group > 0);
  try {
    // Synchronous process inspection leaves this owned child unreaped until the
    // assertion. No sleep or scheduler-dependent SIGCHLD race is needed.
    const deadline = performance.now() + 3_000;
    let status = "";
    while (performance.now() < deadline) {
      status = execFileSync("/bin/ps", ["-p", String(group), "-o", "stat="], { encoding: "utf8" }).trim();
      if (status.startsWith("Z")) break;
    }
    assert.ok(status.startsWith("Z"), "The exact fixture child must have exited but remain unreaped");
    if (process.platform === "darwin") {
      assert.throws(() => process.kill(-group, 0), error => object(error) && error.code === "EPERM",
        "Darwin's zombie-only process group reports EPERM rather than ESRCH");
      assert.equal(await groupAlive(group), false, "An exited child cannot retain profile writers");
    }
    await exited;
    assert.equal(await groupAlive(group), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

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

test("native CDP keeps full Playwright control and exact ownership despite a stalled existing renderer",
  { skip, timeout: 45_000 }, async t => {
  assert.ok(chrome, "AGENT_TEST_CHROME must select an explicit disposable test binary");
  const directory = await mkdtemp(join(tmpdir(), "agent-native-cdp-"));
  const profile = join(directory, "profile");
  let stopChrome: (() => Promise<void>) | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  t.after(async () => {
    const failures: unknown[] = [];
    try { await stopChrome?.(); } catch (error) { failures.push(error); }
    try { await stopServer?.(); } catch (error) { failures.push(error); }
    // Retain the disposable profile and ownership diagnostics if reaping failed.
    if (failures.length) throw new AggregateError(failures, `Fixture cleanup incomplete: ${directory}`);
    await rm(directory, { recursive: true, force: true });
    t.diagnostic("Disposable profile removed after owned Chrome group cleanup");
  });
  const version = await promisify(execFile)(chrome, ["--version", `--user-data-dir=${profile}`,
    "--use-mock-keychain", "--password-store=basic"], { timeout: 5_000 });
  assert.match(version.stdout, /^Google Chrome for Testing /, "Only disposable Chrome for Testing may run this fixture");
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
  queueMicrotask(() => frame.focus());
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
  stopServer = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const args = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--headless=new",
    `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, "--use-mock-keychain",
    "--password-store=basic", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "about:blank"];
  if (process.platform === "linux" || process.getuid?.() === 0) args.unshift("--no-sandbox");
  const processChrome = spawn(chrome, args, { stdio: "ignore", detached: true });
  processChrome.once("error", () => {});
  const exited = new Promise<void>(resolve => processChrome.once("close", () => resolve()));
  let observer: Browser | undefined;
  let recovering: Browser | undefined;
  const hosts: NativeHelper[] = [];
  const nativeTargets = new Set<string>();
  const group = processChrome.pid;
  assert.ok(group !== undefined && group > 0, "The fixture must own an explicit detached Chrome group");
  const signalGroup = async (signal: NodeJS.Signals) => {
    try { process.kill(-group, signal); }
    catch (error) {
      if (object(error) && error.code === "ESRCH") return;
      if (object(error) && error.code === "EPERM" && !await groupAlive(group)) return;
      throw error;
    }
  };
  stopChrome = async () => {
    const failures: unknown[] = [];
    for (const host of hosts) {
      try { await host.close(); } catch (error) { failures.push(error); }
    }
    // The browser's main process may already be gone while its renderer group
    // remains. Reap the group allocated by this spawn, never a discovered port.
    await signalGroup("SIGTERM");
    let deadline = Date.now() + 3_000;
    while (await groupAlive(group) && Date.now() < deadline) await setTimeout(25);
    if (await groupAlive(group)) await signalGroup("SIGKILL");
    deadline = Date.now() + 3_000;
    while (await groupAlive(group) && Date.now() < deadline) await setTimeout(25);
    const empty = !await groupAlive(group);
    t.diagnostic(JSON.stringify({ fixturePid: group, fixtureGroup: group, nativeTargets: [...nativeTargets], groupEmpty: empty }));
    assert.ok(empty, "Every process in the explicitly owned Chrome group must exit before profile removal");
    await exited;
    try { await observer?.close(); } catch (error) { failures.push(error); }
    try { await recovering?.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Owned browser helper cleanup failed");
  };
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
  const browserSession = await observer.newBrowserCDPSession();
  browserSession.on("Target.targetCreated", ({ targetInfo }: { targetInfo: { targetId: string } }) => {
    nativeTargets.add(targetInfo.targetId);
  });
  await browserSession.send("Target.setDiscoverTargets", { discover: true });
  const currentTargets = async () => {
    const targets = await browserSession.send("Target.getTargets");
    for (const target of targets.targetInfos) nativeTargets.add(target.targetId);
    return new Set(targets.targetInfos.map(target => target.targetId));
  };
  await currentTargets();
  const sentinel = await context.newPage(); await sentinel.goto(`${origin}/seed`);
  const sentinelSession = await context.newCDPSession(sentinel);
  const sentinelId = (await sentinelSession.send("Target.getTargetInfo")).targetInfo.targetId;
  nativeTargets.add(sentinelId); await sentinelSession.detach();
  // A separate site gives the stalled user tab its own renderer. Existing
  // renderer initialization must not gate the new task's unrelated web page.
  const stalled = await context.newPage();
  await stalled.goto(`http://localhost:${address.port}/stalled`);
  const stalledSession = await context.newCDPSession(stalled);
  const stalledId = (await stalledSession.send("Target.getTargetInfo")).targetInfo.targetId;
  nativeTargets.add(stalledId);
  void stalledSession.send("Runtime.evaluate", { expression: "while(true){}" }).catch(() => {});
  const frameTree = stalledSession.send("Page.getFrameTree");
  const frameTreeState = await Promise.race([
    frameTree.then(() => "resolved", () => "rejected"), setTimeout(250, "pending"),
  ]);
  assert.equal(frameTreeState, "pending", "The pre-existing renderer must actually stall Page.getFrameTree");
  await assert.rejects(
    chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: false, timeout: 500 }),
    error => error instanceof Error && error.name === "TimeoutError",
    "The normal initialization barrier must remain in effect without noDefaults",
  );
  await currentTargets();
  const initialPages = context.pages().length;
  // Separate helpers reconnect to the same browser without extension pairing.
  for (let helper = 0; helper < 2; helper++) {
    const host = new NativeHelper(port);
    hosts.push(host);
    const owner_id = randomUUID(), session_id = randomUUID();
    const execute = async (action: BrowserAction) => (await host.execute({ owner_id, session_id, operation_id: randomUUID(), action })).response;
    const opened = await execute({ type: "open", url: `${origin}/login` });
    assert.ok(opened.type === "ready", JSON.stringify(opened));
    await currentTargets();
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
      // Let the inline menu take focus before inserting credentials.
      const attached = page.waitForEvent('framenavigated', {predicate: frame => frame.url().startsWith('chrome-extension://'), timeout:5000});
      await page.getByLabel('Name', {exact:true}).focus();
      const foreign = await attached;
      if (!foreign || foreign.isDetached()) throw new Error('Foreign extension frame must remain attached');
      await foreign.waitForLoadState('domcontentloaded');
      await page.getByLabel('Name', {exact:true}).fill(username);
      const ordinary = page.frameLocator('iframe[title="Result"]');
      await ordinary.getByLabel('Frame note').fill('Ordinary frame works');
      await page.getByLabel('Password', {exact:true}).fill(password);
      if (await page.getByLabel('Name', {exact:true}).inputValue() !== username) throw new Error('Name field did not retain the filled credential');
      if (await page.getByLabel('Password', {exact:true}).inputValue() !== password) throw new Error('Password field did not retain the filled credential');
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
    assert.equal(stalled.isClosed(), false);
    const remainingTargets = await currentTargets();
    assert.ok(remainingTargets.has(sentinelId), "Release must preserve the exact pre-existing sentinel target");
    assert.ok(remainingTargets.has(stalledId), "Release must preserve the exact pre-existing stalled target");
    assert.equal(processChrome.exitCode, null, "Disconnect must preserve the user's Chrome process");
    assert.equal(processChrome.signalCode, null);
  }
  // A connection established while the user page is stalled must retain full
  // binding support when that same renderer recovers later.
  recovering = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 5_000 });
  const recoveringContext = recovering.contexts()[0]; assert.ok(recoveringContext);
  const recoveredPage = recoveringContext.waitForEvent("page", {
    predicate: page => page.url() === `http://localhost:${address.port}/stalled`, timeout: 5_000,
  });
  await stalledSession.send("Runtime.terminateExecution");
  await frameTree;
  const recovered = await recoveredPage;
  const recoveredSession = await recoveringContext.newCDPSession(recovered);
  assert.equal((await recoveredSession.send("Target.getTargetInfo")).targetInfo.targetId, stalledId);
  await recoveredSession.detach();
  await recovered.exposeBinding("fixtureRecovered", (_source, value: unknown) => value);
  assert.equal(await recovered.evaluate("window.fixtureRecovered('Recovered binding')"), "Recovered binding");
  await stalledSession.detach();
});
