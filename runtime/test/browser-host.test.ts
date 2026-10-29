import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { BrowserHost } from "../src/browser-host.js";
import type { BrowserAction } from "../src/generated/BrowserAction.js";
import type { BrowserRequest } from "../src/generated/BrowserRequest.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const chrome = [process.env.AGENT_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(path => path !== undefined && existsSync(path));
const skipChrome = chrome === undefined && process.env.CI !== "true";

/** Fixture setup uses the browser protocol directly; assertions exercise Agent's real MCP adapter. */
class ChromeFixtureClient {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
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
      else pending.reject(new Error("Synthetic Chrome rejected a fixture command"));
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Synthetic Chrome disconnected"));
      this.pending.clear();
    });
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async pages(): Promise<{ targetId: string; url: string }[]> {
    const result = await this.call("Target.getTargets");
    assert.ok(Array.isArray(result.targetInfos));
    return result.targetInfos.flatMap((item: unknown) => object(item) && item.type === "page" && typeof item.targetId === "string" && typeof item.url === "string"
      ? [{ targetId: item.targetId, url: item.url }] : []);
  }
  close(): void { this.socket.close(); }
}

async function fixture(slowSubmit = false) {
  assert.ok(chrome);
  let submissions = 0;
  const submittedBodies: string[] = [];
  let delayed: ServerResponse | undefined;
  let submittedResolve = () => {};
  const submitted = new Promise<void>(resolve => { submittedResolve = resolve; });
  const server = createServer((request, response) => {
    if (request.url === "/submit") {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        submittedBodies.push(body); submissions++; submittedResolve();
        if (slowSubmit) { delayed = response; return; }
        response.writeHead(303, { Location: "/done" }).end();
      });
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/form" && !request.headers.cookie?.includes("fixture_login=signed-in")) {
      response.writeHead(401).end("<!doctype html><h1>Sign in required</h1>"); return;
    }
    if (request.url === "/form") response.end(`<!doctype html><title>Owned form</title><h1>Form ready</h1>
      <form action="/submit" method="post"><label>Name<input name="name"></label>
      <label>Choice<select name="choice"><option>First</option><option>Second</option></select></label>
      <button type="button" onclick="window.open('/popup','_blank')">Open popup</button>
      <button type="button" onclick="alert('Fixture dialog')">Open dialog</button><button>Save</button></form>`);
    else if (request.url === "/done") response.end("<!doctype html><title>Saved form</title><h1>Saved</h1>");
    else if (request.url === "/popup") response.end("<!doctype html><title>Owned popup</title><h1>Popup ready</h1>");
    else if (request.url === "/retained") response.end("<!doctype html><title>Retained result</title><h1>Draft ready for review</h1>");
    else response.end("<!doctype html><title>User tab sentinel</title><h1>Unrelated user content sentinel</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-test-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "--no-first-run", "--no-default-browser-check", "about:blank"];
  if (process.getuid?.() === 0) args.unshift("--no-sandbox");
  const browser: ChildProcess = spawn(chrome, args, { stdio: "ignore" });
  const exited = new Promise<void>(resolve => browser.once("exit", () => resolve()));
  let client: ChromeFixtureClient | undefined;
  try {
    let port = "", endpoint = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const lines = (await readFile(join(directory, "DevToolsActivePort"), "utf8")).trim().split("\n");
        const foundPort = lines[0], foundPath = lines[1];
        if (foundPort !== undefined && foundPath !== undefined) { port = foundPort; endpoint = `ws://127.0.0.1:${port}${foundPath}`; break; }
      } catch { /* The disposable browser has not published its endpoint yet. */ }
      if (browser.exitCode !== null) throw new Error("Synthetic Chrome exited before publishing its endpoint");
      await setTimeout(50);
    }
    assert.notEqual(endpoint, "", "Disposable Chrome must start within ten seconds");
    client = new ChromeFixtureClient(endpoint);
    await client.call("Storage.setCookies", { cookies: [{ name: "fixture_login", value: "signed-in", url: origin, httpOnly: true, sameSite: "Lax" }] });
    await client.call("Target.createTarget", { url: `${origin}/unrelated` });
    const fixtureClient = client;
    return {
      origin, browser, client: fixtureClient, submitted,
      host: () => new BrowserHost({ user_data_dir: null }, { serverArguments: [`--browser-url=http://127.0.0.1:${port}`] }),
      count: () => submissions,
      submittedBodies: () => [...submittedBodies],
      finishSubmission() { delayed?.writeHead(303, { Location: "/done" }).end(); delayed = undefined; },
      async close() {
        delayed?.end(); fixtureClient.close(); browser.kill("SIGTERM"); await exited;
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    client?.close(); browser.kill("SIGTERM"); await exited;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true }); throw error;
  }
}

function requests() {
  const owner_id = randomUUID(), session_id = randomUUID();
  return (action: BrowserAction, operation_id = randomUUID()): BrowserRequest => ({ owner_id, session_id, operation_id, action });
}

function elementRef(output: string, role: string, name: string): string {
  const value: unknown = JSON.parse(output);
  assert.ok(object(value));
  function find(node: unknown): string | undefined {
    if (!object(node)) return undefined;
    if (node.role === role && node.name === name && typeof node.id === "string") return node.id;
    if (Array.isArray(node.children)) for (const child of node.children) { const found = find(child); if (found !== undefined) return found; }
    return undefined;
  }
  const result = find(value.snapshot); assert.ok(result, `Snapshot must contain ${role} ${name}`); return result;
}

test("real Chrome adapter owns exact tabs and scoped popups, preserves unrelated pages and deduplicates mutations", { skip: skipChrome, timeout: 120_000 }, async () => {
  const f = await fixture(), host = f.host(), request = requests();
  try {
    const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
    assert.ok(opened.type === "ready", JSON.stringify(opened)); assert.equal(opened.is_error, false);
    assert.equal(opened.tabs.length, 1); const tab = opened.tabs[0]; assert.ok(tab);
    assert.equal(tab.url, `${f.origin}/form`);
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
    await f.client.call("Target.createTarget", { url: `${f.origin}/user-concurrent` });
    const popup = (await popupPending).response;
    assert.ok(popup.type === "ready", JSON.stringify(popup)); assert.equal(popup.is_error, false);
    assert.equal(popup.tabs.length, 2); assert.ok(popup.tabs.some(page => page.url === `${f.origin}/popup`));
    assert.equal(JSON.stringify(popup).includes("user-concurrent"), false);
    const dialog = (await host.execute(request({ type: "click", tab_id: tab.id, element_ref: elementRef(popup.output, "button", "Open dialog") }))).response;
    assert.ok(dialog.type === "ready"); assert.ok(dialog.output.includes("Fixture dialog"));
    const accepted = (await host.execute(request({ type: "handle_dialog", tab_id: tab.id, accept: true, prompt_text: null }))).response;
    assert.ok(accepted.type === "ready"); assert.equal(accepted.is_error, false);

    const submission = request({ type: "click", tab_id: tab.id, element_ref: elementRef(accepted.output, "button", "Save") });
    const saved = (await host.execute(submission)).response;
    assert.ok(saved.type === "ready", JSON.stringify(saved)); assert.equal(saved.is_error, false); assert.equal(f.count(), 1);
    const body = new URLSearchParams(f.submittedBodies()[0]);
    assert.equal(body.get("name"), "Synthetic user");
    assert.equal(body.get("choice"), "Second");
    assert.equal((await host.execute(submission)).response.type, "failed"); assert.equal(f.count(), 1, "A reused operation ID cannot submit twice");
    const partialFailure = (await host.execute(request({ type: "click", tab_id: tab.id, element_ref: "missing-element" }))).response;
    assert.equal(partialFailure.type, "uncertain", "An upstream mutation error does not establish that nothing happened");
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
    const released = (await host.execute(request({ type: "release" }))).response;
    assert.ok(released.type === "closed", JSON.stringify(released)); assert.equal(released.tabs.length, 0);
    const pages = await f.client.pages();
    assert.ok(pages.some(page => page.url === `${f.origin}/unrelated`));
    assert.ok(pages.some(page => page.url === `${f.origin}/user-concurrent`));
    assert.ok(pages.some(page => page.url === `${f.origin}/retained`), "An explicitly retained draft must survive cleanup");
    assert.equal(pages.some(page => page.url === `${f.origin}/done` || page.url === `${f.origin}/popup`), false);
    assert.equal(f.browser.exitCode, null, "Disconnect must leave attached Chrome running");
  } finally { await host.close(); await f.close(); }
});

test("lost browser transport leaves a submitted mutation uncertain without replaying or closing its tab", { skip: skipChrome, timeout: 60_000 }, async () => {
  const f = await fixture(true), host = f.host(), request = requests();
  try {
    const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
    assert.ok(opened.type === "ready", JSON.stringify(opened)); const tab = opened.tabs[0]; assert.ok(tab);
    const operation = request({ type: "click", tab_id: tab.id, element_ref: elementRef(opened.output, "button", "Save") });
    const pending = host.execute(operation);
    await Promise.race([f.submitted, setTimeout(15_000, undefined, { ref: false }).then(() => { throw new Error("Fixture submission did not arrive"); })]);
    assert.equal(f.count(), 1); await host.close();
    assert.equal((await pending).response.type, "uncertain");
    assert.equal((await host.execute(operation)).response.type, "failed"); assert.equal(f.count(), 1);
    f.finishSubmission();
    assert.equal((await host.execute(request({ type: "snapshot", tab_id: tab.id }))).response.type, "disconnected");
    const pages = await f.client.pages();
    assert.ok(pages.some(page => page.url.startsWith(f.origin) && page.url !== `${f.origin}/unrelated`));
    assert.equal(f.browser.exitCode, null);
  } finally { await host.close(); await f.close(); }
});

test("release reports final-page closure from native readback, including any retained page", { skip: skipChrome, timeout: 60_000 }, async () => {
  const f = await fixture(), host = f.host(), request = requests();
  try {
    const opened = (await host.execute(request({ type: "open", url: `${f.origin}/form` }))).response;
    assert.ok(opened.type === "ready", JSON.stringify(opened)); const tab = opened.tabs[0]; assert.ok(tab);
    for (const page of await f.client.pages()) if (page.url !== tab.url) await f.client.call("Target.closeTarget", { targetId: page.targetId });
    const released = (await host.execute(request({ type: "release" }))).response;
    assert.ok(released.type === "closed", JSON.stringify(released));
    const remaining = (await f.client.pages()).filter(page => page.url === tab.url);
    assert.equal(released.tabs.length, remaining.length, "The receipt must agree with independent native readback, whether the final-page guard retained it or closure completed");
    if (remaining.length > 0) assert.equal(released.tabs[0]?.id, tab.id);
    assert.equal(f.browser.exitCode, null);
  } finally { await host.close(); await f.close(); }
});
