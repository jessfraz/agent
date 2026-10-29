import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { format, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { Ajv2020 } from "ajv/dist/2020.js";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { chromium, type Browser, type BrowserContext, type Dialog, type Frame, type Page } from "playwright-core";
import type { BrowserAction } from "./generated/BrowserAction.js";
import type { BrowserConfig } from "./generated/BrowserConfig.js";
import type { BrowserReply } from "./generated/BrowserReply.js";
import type { BrowserRequest } from "./generated/BrowserRequest.js";
import type { BrowserResponse } from "./generated/BrowserResponse.js";
import type { BrowserTab } from "./generated/BrowserTab.js";

const OUTPUT_LIMIT = 64 * 1024;
const ACTION_TIMEOUT = 30_000;
const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const MAX_PASSWORD_VALUES = 128;
const MAX_PASSWORD_CHARS = 8192;
const MAX_PASSWORD_BYTES = 64 * 1024;
const WEB_DOCUMENT_PROTOCOLS = new Set(["http:", "https:", "about:", "file:", "data:", "blob:"]);
const exec = promisify(execFile);

export type BrowserHostOptions = {
  /** Tests target only their disposable Chrome profile and isolated registries. */
  serverArguments?: readonly string[];
  extensionToken?: string;
  environment?: Record<string, string>;
};

type ConnectionStage = "pairing" | "mcp_transport" | "extension_attach" | "endpoint_discovery"
  | "browser_attach" | "profile_context" | "connector_identity" | "page_creation" | "connector_cleanup";
type ControlLoss = "mcp_closed" | "browser_disconnected" | "owned_page_closed";

/** Only fixed diagnostic labels can cross the secret-bearing bootstrap boundary. */
class ConnectionFailure extends Error {
  constructor(readonly stage: ConnectionStage) { super(`Chrome connection failed at ${stage}`); }
}

type OwnedTab = {
  info: BrowserTab;
  page: Page;
  refs: Map<string, string>;
  dialog?: Dialog;
  pending?: Promise<void>;
  dialogOpened: Promise<void>;
  notifyDialog: () => void;
  popup: (page: Page) => void;
  onDialog: (dialog: Dialog) => void;
  onDialogClosed: (dialog: Dialog) => void;
  closing: boolean;
  script?: { result?: unknown; logs: string[] };
  captureName: string;
  captureReady: Promise<void>;
};

type CaptureOptions = { binding: string; control: string; maxValues: number; maxChars: number; protocols: string[] };
// These module-local browser shapes describe only the serialized collector.
// Loading DOM globals into the server project changes Node's fetch types.
type CaptureInput = { type: string; value: string };
type CaptureRoot = { querySelectorAll(selector: string): Iterable<CaptureInput> & { length: number } };
type CaptureEvent = { composedPath(): unknown[] };
type CaptureMutation = { target: unknown; attributeName: string | null; oldValue: string | null; addedNodes: Iterable<unknown> };
declare const location: { protocol: string };
declare const document: CaptureRoot & {
  addEventListener(type: string, listener: (event: CaptureEvent) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: CaptureEvent) => void, capture: boolean): void;
};
declare const HTMLInputElement: { new(): CaptureInput; prototype: CaptureInput };
declare const Element: { new(): CaptureRoot };
declare const MutationObserver: { new(callback: (records: CaptureMutation[]) => void): {
  observe(target: typeof document, options: { subtree: boolean; childList: boolean; attributes: boolean;
    attributeOldValue: boolean; attributeFilter: string[] }): void;
  disconnect(): void;
} };
declare function addEventListener(type: string, listener: () => void, capture: boolean): void;
declare function removeEventListener(type: string, listener: () => void, capture: boolean): void;

/** Serialized into owned web documents; secrets leave only through the private binding. */
async function installPasswordCapture(options: CaptureOptions): Promise<void> {
  if (!options.protocols.includes(location.protocol)) return;
  const origin: unknown = Reflect.get(globalThis, "origin");
  if (typeof origin === "string" && origin.startsWith("chrome-extension:")) return;
  if (Reflect.has(globalThis, options.control)) return;
  const binding: unknown = Reflect.get(globalThis, options.binding);
  if (typeof binding !== "function") throw new Error("Password capture binding is unavailable");
  // Install synchronously before document scripts can set and clear a secret.
  // Publishing remains gated by the helper's exact Page ownership check.
  let active = true, failed = false, authorized = false;
  const buffered = new Set<string>();
  const pending = new Set<Promise<void>>();
  const known = new WeakSet<CaptureInput>();
  const publish = (value: string): void => {
    if (!active || failed || value.length === 0) return;
    if (value.length > options.maxChars || pending.size >= options.maxValues) {
      failed = true;
      void Promise.resolve(binding({ failed: true })).catch(() => {});
      return;
    }
    if (!authorized) {
      if (buffered.size >= options.maxValues && !buffered.has(value)) {
        failed = true; return;
      }
      buffered.add(value); return;
    }
    const sent = Promise.resolve(binding({ value })).then(() => {}, () => { failed = true; })
      .finally(() => pending.delete(sent));
    pending.add(sent);
  };
  const capture = (element: unknown): void => {
    if (!(element instanceof HTMLInputElement)) return;
    if (element.type !== "password" && !known.has(element)) return;
    known.add(element); publish(element.value);
  };
  const scan = (root: CaptureRoot): void => {
    const inputs = root.querySelectorAll('input[type="password"]');
    if (inputs.length > options.maxValues) {
      failed = true; void Promise.resolve(binding({ failed: true })).catch(() => {}); return;
    }
    for (const input of inputs) capture(input);
  };
  const listener = (event: CaptureEvent): void => {
    for (const target of event.composedPath()) capture(target);
  };
  const events = ["beforeinput", "input", "change", "focusin"];
  const leaving = () => scan(document);
  const listen = () => {
    for (const event of events) document.addEventListener(event, listener, true);
    addEventListener("pagehide", leaving, true);
    addEventListener("beforeunload", leaving, true);
    document.addEventListener("DOMContentLoaded", leaving, true);
  };
  listen();
  const restored: Array<() => void> = [];
  for (const property of ["value", "type"]) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, property);
    const setter = descriptor?.set;
    if (descriptor === undefined || setter === undefined) throw new Error("Password capture setter is unavailable");
    const wrapped = function(this: CaptureInput, value: unknown): void {
      capture(this); setter.call(this, value); capture(this);
    };
    Object.defineProperty(HTMLInputElement.prototype, property, { ...descriptor, set: wrapped });
    restored.push(() => {
      if (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, property)?.set === wrapped) {
        Object.defineProperty(HTMLInputElement.prototype, property, descriptor);
      }
    });
  }
  const observer = new MutationObserver(records => {
    // document.open (including Playwright setContent) removes listeners but
    // keeps this Document and its observer. Restore them for the new tree.
    if (records.some(record => record.target === document)) listen();
    for (const record of records) {
      if (record.target instanceof HTMLInputElement && (record.target.type === "password" || known.has(record.target))) {
        if (record.attributeName === "value" && record.oldValue !== null) publish(record.oldValue);
        capture(record.target);
      }
      for (const node of record.addedNodes) if (node instanceof Element) { capture(node); scan(node); }
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["value", "type"] });
  const stop = async () => {
    active = false; buffered.clear(); observer.disconnect();
    for (const event of events) document.removeEventListener(event, listener, true);
    removeEventListener("pagehide", leaving, true); removeEventListener("beforeunload", leaving, true);
    document.removeEventListener("DOMContentLoaded", leaving, true);
    for (const restore of restored) restore();
    await Promise.all([...pending]); Reflect.deleteProperty(globalThis, options.control);
  };
  Reflect.set(globalThis, options.control, {
    get active() { return active && !failed; },
    async flush() {
      await authorization;
      scan(document); await Promise.all([...pending]);
      if (failed || !active) throw new Error("Password capture could not be verified");
    },
    stop,
  });
  scan(document);
  const authorization = Promise.resolve(binding({ ready: true })).then(async allowed => {
    if (allowed !== true || !active) { await stop(); return; }
    authorized = true;
    if (failed) { await binding({ failed: true }); return; }
    for (const value of buffered) publish(value);
    buffered.clear();
  }).catch(() => { failed = true; });
  await authorization;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function output(message: string, state: Record<string, unknown> = {}, redact: (value: string) => string = value => value): string {
  // Values are scrubbed before JSON escaping; the final pass also covers keys
  // and values a custom serializer encoded before returning them.
  const bytes = Buffer.from(redact(JSON.stringify({ message, ...state }, (_key, value: unknown) =>
    typeof value === "string" ? redact(value) : value)));
  return bytes.length <= OUTPUT_LIMIT ? bytes.toString("utf8")
    : bytes.subarray(0, OUTPUT_LIMIT - 64).toString("utf8") + "\n[Browser output truncated.]";
}

function allowedUrl(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
  } catch { return false; }
}

function mutates(action: BrowserAction): boolean {
  return action.type !== "status" && action.type !== "snapshot" && action.type !== "wait_for" && action.type !== "retain_tab";
}

function connector(page: Page, name: string): boolean {
  try {
    const url = new URL(page.url());
    if (url.protocol !== "chrome-extension:" || url.hostname !== EXTENSION_ID || url.pathname !== "/connect.html") return false;
    const client: unknown = JSON.parse(url.searchParams.get("client") ?? "null");
    return object(client) && client.name === name;
  } catch { return false; }
}

/** Owns one conversation's connection, never the external Chrome. */
export class BrowserHost {
  private client: McpClient | undefined;
  private browser: Browser | undefined;
  private owner: { owner_id: string; session_id: string } | undefined;
  private readonly owned = new Map<number, OwnedTab>();
  private readonly operations = new Set<string>();
  private nextId = 1;
  private queue: Promise<void> = Promise.resolve();
  private disconnected = false;
  private closing = false;
  private controlLoss: ControlLoss | undefined;
  private readonly passwords = new Set<string>();
  private passwordBytes = 0;
  private captureFailed = false;
  private redaction: { token: string | undefined; pattern: RegExp } | undefined;

  constructor(private readonly config: Pick<BrowserConfig, "user_data_dir" | "profile_dir_name">
    & Partial<Pick<BrowserConfig, "debugging_port" | "secret_environment">>,
    private readonly options: BrowserHostOptions = {}) {}

  execute(request: BrowserRequest): Promise<BrowserReply> {
    const repeatable = request.action.type === "status" || request.action.type === "snapshot" || request.action.type === "wait_for";
    if (!repeatable && this.operations.has(request.operation_id)) return Promise.resolve({ operation_id: request.operation_id,
      response: { type: "failed", session_id: request.session_id, message: "This browser operation ID was already used; its effect will not run again." } });
    if (!repeatable) this.operations.add(request.operation_id);
    const pending = this.queue.then(async () => ({ operation_id: request.operation_id, response: await this.run(request) }));
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }

  /** EOF and signals disconnect only. Explicit tab actions own Page.close calls. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.owned.values()].map(tab => this.stopCapture(tab).catch(() => {})));
    try { await this.browser?.close(); } finally {
      await this.client?.close();
      this.client = undefined;
      this.browser = undefined;
      this.disconnected = true;
      this.owned.clear();
      this.passwords.clear(); this.passwordBytes = 0; this.redaction = undefined;
    }
  }

  private tabs(): BrowserTab[] { return [...this.owned.values()].map(tab => ({ ...tab.info,
    url: this.redact(tab.info.url), title: this.redact(tab.info.title) })); }

  private redact(value: string): string {
    if (this.captureFailed) throw new Error("Password capture could not be verified");
    const token = (this.options.extensionToken ?? process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN)
      ?.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, "");
    if (this.redaction !== undefined && this.redaction.token === token) return value.replace(this.redaction.pattern, "[redacted]");
    const secrets = [...this.passwords];
    if (token !== undefined && token.length > 0) secrets.push(token);
    const patterns = new Set<string>();
    for (const secret of secrets) {
      let variants: string[];
      try { variants = [secret, JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6),
        format("%o", secret), format("%o", secret).slice(1, -1)]; }
      catch { this.captureFailed = true; throw new Error("Password capture could not be verified"); }
      for (const variant of variants) {
        if (variant.length > 0) patterns.add(variant.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"));
      }
    }
    if (patterns.size === 0) return value;
    // One pass cannot reprocess replacement text, including short passwords.
    // The fixed marker stays idempotent through pre/post-serialization passes.
    patterns.add("\\[redacted\\]");
    const pattern = new RegExp([...patterns].sort((left, right) => right.length - left.length).join("|"), "g");
    this.redaction = { token, pattern };
    return value.replace(pattern, "[redacted]");
  }

  private rememberPassword(value: unknown): void {
    if (typeof value !== "string") { this.captureFailed = true; return; }
    if (value.length === 0 || this.passwords.has(value)) return;
    const bytes = Buffer.byteLength(value);
    if (value.length > MAX_PASSWORD_CHARS || this.passwords.size >= MAX_PASSWORD_VALUES
        || this.passwordBytes + bytes > MAX_PASSWORD_BYTES) { this.captureFailed = true; return; }
    this.passwords.add(value); this.passwordBytes += bytes; this.redaction = undefined;
  }

  private webFrame(frame: Frame): boolean {
    for (let current: Frame | null = frame; current !== null; current = current.parentFrame()) {
      try { if (!WEB_DOCUMENT_PROTOCOLS.has(new URL(current.url()).protocol)) return false; }
      catch { return false; }
    }
    return true;
  }

  private async prepareCapture(tab: OwnedTab): Promise<void> {
    const binding = "agentPassword_" + randomUUID().replaceAll("-", "");
    await tab.page.exposeBinding(binding, (source, message: unknown) => {
      if (this.closing || !this.owned.has(tab.info.id) || source.page !== tab.page) return false;
      if (!this.webFrame(source.frame)) return;
      if (object(message) && message.ready === true) return true;
      if (!object(message) || message.failed === true || typeof message.value !== "string") {
        this.captureFailed = true; return;
      }
      this.rememberPassword(message.value);
    });
    const options: CaptureOptions = { binding, control: tab.captureName, maxValues: MAX_PASSWORD_VALUES,
      maxChars: MAX_PASSWORD_CHARS, protocols: [...WEB_DOCUMENT_PROTOCOLS] };
    await tab.page.addInitScript(installPasswordCapture, options);
    for (const frame of tab.page.frames()) {
      if (this.webFrame(frame)) await frame.evaluate(installPasswordCapture, options);
    }
  }

  private async capturePasswords(tab: OwnedTab): Promise<void> {
    await tab.captureReady;
    if (this.captureFailed) throw new Error("Password capture could not be verified");
    for (const frame of tab.page.frames()) {
      if (!this.webFrame(frame)) continue;
      try {
        const values = await frame.locator('input[type="password"]').evaluateAll((inputs: unknown[]) => inputs.map(input => {
          if (!(input instanceof HTMLInputElement)) throw new Error("Invalid password field");
          return input.value;
        }));
        for (const value of values) this.rememberPassword(value);
        await frame.evaluate(async name => {
          let control: unknown;
          for (let attempt = 0; attempt < 100; attempt++) {
            control = Reflect.get(globalThis, name);
            if (typeof control === "object" && control !== null) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          if (typeof control !== "object" || control === null || Reflect.get(control, "active") !== true) throw new Error("Password capture is unavailable");
          const flush: unknown = Reflect.get(control, "flush");
          if (typeof flush !== "function") throw new Error("Password capture is unavailable");
          await flush();
        }, tab.captureName);
      } catch { this.captureFailed = true; throw new Error("Password capture could not be verified"); }
    }
    if (this.captureFailed) throw new Error("Password capture could not be verified");
  }

  private async stopCapture(tab: OwnedTab): Promise<void> {
    const timer = new AbortController();
    try {
      await Promise.race([(async () => {
        await tab.captureReady;
        for (const frame of tab.page.frames()) {
          if (!this.webFrame(frame)) continue;
          await frame.evaluate(async name => {
            const control: unknown = Reflect.get(globalThis, name);
            if (typeof control !== "object" || control === null) return;
            const stop: unknown = Reflect.get(control, "stop");
            if (typeof stop === "function") await stop();
          }, tab.captureName);
        }
      })(), delay(1000, undefined, { signal: timer.signal, ref: false }).then(() => {
        throw new Error("Password capture shutdown timed out");
      })]);
    } finally { timer.abort(); }
  }

  private lost(reason: ControlLoss): void {
    if (!this.closing) this.controlLoss ??= reason;
    this.disconnected = true;
  }

  private failureDetail(error?: unknown): string {
    if (error instanceof ConnectionFailure) return `Connection stage: ${error.stage}.`;
    return this.controlLoss === undefined ? "Failure stage: browser_operation." : `Control lost: ${this.controlLoss}.`;
  }

  private liveBrowser(): Browser {
    if (this.disconnected || this.closing || this.browser?.isConnected() !== true) throw new Error("Browser connection closed");
    return this.browser;
  }

  private childEnvironment(token: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME",
      "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL"]) {
      const value = process.env[name]; if (value !== undefined) env[name] = value;
    }
    return { ...env, ...this.options.environment, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token };
  }

  private async connect(): Promise<Page | undefined> {
    if (this.browser !== undefined) return undefined;
    if (this.config.debugging_port !== undefined && this.config.debugging_port !== null) return this.connectNative(this.config.debugging_port);
    const rawToken = this.options.extensionToken ?? process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    // The extension's Copy button includes the environment assignment.
    const token = rawToken?.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, "");
    if (token === undefined || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new ConnectionFailure("pairing");
    if (this.owner === undefined) throw new Error("Browser owner is missing");
    const name = "Agent " + this.owner.session_id;
    const executable = fileURLToPath(new URL("./cli.js", import.meta.resolve("@playwright/mcp/package.json")));
    const args = this.options.serverArguments ?? ["--extension", "--browser", "chrome",
      ...(this.config.profile_dir_name === null ? [] : ["--profile-dir-name", this.config.profile_dir_name]),
      ...(this.config.user_data_dir === null ? [] : ["--user-data-dir", this.config.user_data_dir])];
    const env = this.childEnvironment(token);
    const transport = new StdioTransport({ command: process.execPath,
      args: [executable, ...args, "--codegen", "none", "--snapshot-mode", "none", "--image-responses", "omit", "--console-level", "error"],
      inheritEnv: false, env, stderr: "pipe", maxStderrBytes: 4096, maxMessageBytes: 4 * 1024 * 1024 });
    const client = new McpClient({ name, version: "0.1.0", requestTimeoutMs: 45_000 });
    this.client = client;
    client.onClose(() => this.lost("mcp_closed"));
    let stage: ConnectionStage = "mcp_transport";
    try {
      await client.connect(transport);
      stage = "extension_attach";
      // Connector URLs contain the token. Keep all bootstrap output, server
      // inventory, upstream errors and stderr out of model output and logs.
      const bootstrap = await client.callTool("browser_tabs", { action: "list" });
      if (bootstrap.isError === true) throw new Error("Chrome extension did not connect");
      stage = "endpoint_discovery";
      const cli = fileURLToPath(new URL("./playwright-cli.js", import.meta.resolve("@playwright/cli/package.json")));
      const { PLAYWRIGHT_MCP_EXTENSION_TOKEN: _token, ...cliEnv } = env;
      const listed = await exec(process.execPath, [cli, "list", "--all", "--json"],
        { env: cliEnv, timeout: 15_000, maxBuffer: 1024 * 1024 });
      const inventory: unknown = JSON.parse(listed.stdout);
      if (!object(inventory) || !Array.isArray(inventory.servers)) throw new Error("Invalid browser server inventory");
      const matches = inventory.servers.filter((server: unknown) => object(server) && server.title === name);
      const descriptor: unknown = matches[0];
      if (matches.length !== 1 || !object(descriptor) || typeof descriptor.endpoint !== "string") throw new Error("Browser endpoint identity was not confirmed");
      stage = "browser_attach";
      const browser = await chromium.connect(descriptor.endpoint, { timeout: 15_000 });
      this.browser = browser;
      browser.on("disconnected", () => this.lost("browser_disconnected"));
      stage = "profile_context";
      const context = browser.contexts()[0];
      if (context === undefined || browser.contexts().length !== 1) throw new Error("Browser profile context was not confirmed");
      this.trackCreatedPages(context);
      stage = "connector_identity";
      const connectors = context.pages().filter(page => connector(page, name));
      if (connectors.length !== 1) throw new Error("Browser connector identity was not confirmed");
      // The final attached page disconnects the extension when closed. Create
      // a positively owned page before removing its private connector.
      stage = "page_creation";
      const page = await context.newPage();
      this.adopt(page);
      stage = "connector_cleanup";
      await connectors[0]?.close();
      return page;
    } catch {
      await this.close().catch(() => {});
      throw new ConnectionFailure(stage);
    }
  }

  private trackCreatedPages(context: BrowserContext): void {
    context.setDefaultTimeout(ACTION_TIMEOUT);
    context.setDefaultNavigationTimeout(ACTION_TIMEOUT);
    const newPage = context.newPage.bind(context);
    // Only direct creation and owned openers establish ownership. Install
    // privacy capture before returning a new Page to arbitrary scripts.
    context.newPage = async () => {
      const tab = this.adopt(await newPage()); await tab.captureReady; return tab.page;
    };
  }

  private async connectNative(port: number): Promise<Page> {
    let stage: ConnectionStage = "browser_attach";
    try {
      if (!Number.isInteger(port) || port < 1 || port > 65535
          || this.config.user_data_dir !== null || this.config.profile_dir_name !== null) {
        throw new Error("Invalid native Chrome configuration");
      }
      // Preserve the externally owned browser's settings. Native CDP can
      // control web pages while password-manager frames stay attached.
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 15_000 });
      this.browser = browser;
      browser.on("disconnected", () => this.lost("browser_disconnected"));
      stage = "profile_context";
      const context = browser.contexts()[0];
      if (context === undefined) throw new Error("Chrome default context is unavailable");
      this.trackCreatedPages(context);
      stage = "page_creation";
      return await context.newPage();
    } catch {
      await this.close().catch(() => {});
      throw new ConnectionFailure(stage);
    }
  }

  private adopt(page: Page): OwnedTab {
    const existing = [...this.owned.values()].find(tab => tab.page === page);
    if (existing !== undefined) return existing;
    if (this.nextId > 0xffff_ffff) throw new Error("Browser tab handles are exhausted");
    let notify = () => {};
    const dialogOpened = new Promise<void>(resolve => { notify = resolve; });
    const tab: OwnedTab = { info: { id: this.nextId++, url: page.url(), title: "" }, page, refs: new Map(),
      dialogOpened, notifyDialog: notify,
      popup: popup => { if (this.owned.has(tab.info.id)) this.adopt(popup); },
      onDialog: dialog => { tab.dialog = dialog; tab.notifyDialog(); },
      onDialogClosed: dialog => this.dialogClosed(tab, dialog), closing: false,
      captureName: "agentCapture_" + randomUUID().replaceAll("-", ""), captureReady: Promise.resolve() };
    this.owned.set(tab.info.id, tab);
    tab.captureReady = this.prepareCapture(tab).catch(() => { this.captureFailed = true; });
    page.on("popup", tab.popup);
    page.on("dialog", tab.onDialog);
    page.on("dialogclosed", tab.onDialogClosed);
    page.once("close", () => {
      // The extension also emits Page.close when Chrome detaches its debugger.
      // Only our acknowledged native close can establish disposable cleanup.
      if (this.owned.has(tab.info.id) && !tab.closing && !this.closing) this.lost("owned_page_closed");
    });
    return tab;
  }

  private async retain(tab: OwnedTab): Promise<void> {
    await this.capturePasswords(tab); await this.stopCapture(tab);
    this.owned.delete(tab.info.id);
    tab.page.off("popup", tab.popup);
    tab.page.off("dialog", tab.onDialog);
    tab.page.off("dialogclosed", tab.onDialogClosed);
  }

  private dialogClosed(tab: OwnedTab, dialog: Dialog): void {
    if (tab.dialog !== dialog) return;
    delete tab.dialog;
    tab.dialogOpened = new Promise<void>(resolve => { tab.notifyDialog = resolve; });
  }

  private async refresh(): Promise<void> {
    // An opener's native modal can also block its popup's renderer. Metadata
    // reads must not delay returning the dialog that the next action handles.
    const modal = [...this.owned.values()].some(tab => tab.dialog !== undefined);
    for (const tab of this.owned.values()) {
      if (tab.page.isClosed()) {
        this.lost("owned_page_closed");
        throw new Error("Owned browser page lost control without confirmed cleanup");
      }
      tab.info.url = tab.page.url();
      // Native modals block page commands, including title and snapshot.
      if (!modal) tab.info.title = await tab.page.title();
      if (!modal) await this.capturePasswords(tab);
    }
  }

  private async state(tab: OwnedTab, message: string): Promise<string> {
    const script = tab.script === undefined ? {} : { result: tab.script.result, logs: tab.script.logs };
    if (tab.dialog !== undefined) return output(message, { dialog: { type: tab.dialog.type(),
      message: tab.dialog.message(), defaultValue: tab.dialog.defaultValue() }, ...script }, value => this.redact(value));
    const children = await tab.page.locator("body").ariaSnapshotJSON({ mode: "ai" });
    await this.capturePasswords(tab);
    tab.refs.clear();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) { for (const child of node) collect(child); return; }
      if (!object(node)) return;
      if (typeof node.ref === "string" && typeof node.role === "string") tab.refs.set(node.ref, node.role);
      if (Array.isArray(node.children)) for (const child of node.children) collect(child);
    };
    collect(children);
    return output(message, { snapshot: { children }, ...script }, value => this.redact(value));
  }

  private async runCode(tab: OwnedTab, code: string): Promise<void> {
    await this.capturePasswords(tab);
    const script: { result?: unknown; logs: string[] } = { logs: [] };
    const log = (...values: unknown[]) => { script.logs.push(format(...values)); };
    // This is the normal Playwright Page, with its full API. The VM provides
    // script scope, not a security sandbox; task authorization still applies.
    const invoke: unknown = runInNewContext(`(${code})`, {
      console: { log, info: log, warn: log, error: log },
      Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout,
      setInterval, clearInterval, AbortController, AbortSignal, fetch, Headers,
      Request, Response, FormData, Blob, crypto, atob, btoa, structuredClone,
    });
    if (typeof invoke !== "function") throw new Error("Playwright code must be an async function receiving page");
    tab.script = script;
    // Normal Playwright scripts await their operations and handle dialogs with
    // Page event handlers. Keep the host's native-input lease until completion.
    await tab.page.bringToFront();
    const secret = (name: unknown): string => {
      if (typeof name !== "string" || name === "OP_SERVICE_ACCOUNT_TOKEN"
          || this.config.secret_environment?.includes(name) !== true) throw new Error("This browser credential is not configured");
      const value = process.env[name];
      if (value === undefined || value.length === 0) throw new Error("The configured browser credential is unavailable");
      this.rememberPassword(value);
      return value;
    };
    script.result = await invoke(tab.page, secret);
    await this.capturePasswords(tab);
  }

  private async effect(tab: OwnedTab, action: () => Promise<unknown>): Promise<void> {
    if (tab.dialog !== undefined) throw new Error("Handle the current browser dialog first");
    const pending = action().then(() => {
      if (tab.pending === pending) delete tab.pending;
    }, error => {
      if (tab.pending === pending) delete tab.pending;
      throw error;
    });
    tab.pending = pending;
    // Keep the original action while a modal is open. Resolving it later must
    // never replay a click or form submission.
    await Promise.race([pending, tab.dialogOpened]);
    if (tab.dialog === undefined) delete tab.pending;
  }

  private async run(request: BrowserRequest): Promise<BrowserResponse> {
    const { session_id, action } = request;
    if (this.owner === undefined) this.owner = { owner_id: request.owner_id, session_id };
    if (this.owner.owner_id !== request.owner_id || this.owner.session_id !== session_id) return {
      type: "failed", session_id, message: "This browser connection belongs to another conversation or session." };
    if (this.disconnected || this.closing) return { type: "disconnected", session_id,
      message: `${this.failureDetail()} Chrome control was lost. Native tabs may still be open and their cleanup was not verified. Old tab handles are invalid; inspect Chrome before continuing.` };
    if ((action.type === "open" || action.type === "new_tab" || action.type === "navigate") && !allowedUrl(action.url)) return {
      type: "failed", session_id, message: "Browser navigation requires an HTTP or HTTPS URL without embedded credentials, or about:blank." };
    if ("tab_id" in action && !this.owned.has(action.tab_id)) return { type: "failed", session_id,
      message: "This tab is not owned by this browser connection. Read its current tabs before continuing." };
    if (action.type === "status" && this.browser === undefined) return { type: "ready", session_id, tabs: [],
      output: output("The browser connection has not been opened."), is_error: false };
    if (action.type === "release") return this.release(session_id);
    try {
      const firstPage = await this.connect();
      const browser = this.liveBrowser();
      await this.refresh();
      this.liveBrowser();
      if (action.type === "status") return { type: "ready", session_id, tabs: this.tabs(),
        output: output("Current owned Chrome tabs.", { available_secrets: this.config.secret_environment ?? [] }), is_error: false };
      let tab: OwnedTab;
      if (action.type === "open" || action.type === "new_tab") {
        const context = browser.contexts()[0];
        if (context === undefined) throw new Error("Browser context closed");
        tab = this.adopt(firstPage ?? await context.newPage());
        if (action.url !== "about:blank") await this.effect(tab, () => tab.page.goto(action.url, { waitUntil: "domcontentloaded" }));
      } else {
        const owned = this.owned.get(action.tab_id);
        if (owned === undefined) return { type: "failed", session_id, message: "The owned tab was closed or removed. Its handle is no longer valid." };
        tab = owned;
        if (action.type === "retain_tab") {
          if (tab.dialog !== undefined || tab.pending !== undefined) return { type: "failed", session_id, message: "Resolve the owned tab's pending action or dialog before retaining it." };
          await this.retain(tab);
          return { type: "ready", session_id, tabs: this.tabs(), output: output("The result tab was retained for the user and released from disposable task ownership."), is_error: false };
        }
        if (action.type === "close_tab") {
          await this.closeTab(tab);
          if (this.owned.size === 0) {
            await this.close();
            return { type: "closed", session_id, tabs: [], output: output("The final owned tab was closed and the Chrome connection was released.") };
          }
          this.liveBrowser();
          return { type: "ready", session_id, tabs: this.tabs(), output: output("The owned tab was closed."), is_error: false };
        }
        if (action.type === "handle_dialog") {
          const dialog = tab.dialog;
          if (dialog === undefined) return { type: "failed", session_id, message: "This owned tab has no current dialog." };
          const pending = tab.pending;
          if (action.accept) await dialog.accept(action.prompt_text ?? undefined); else await dialog.dismiss();
          this.dialogClosed(tab, dialog);
          if (pending !== undefined) await Promise.race([pending, tab.dialogOpened]);
        } else if (tab.dialog === undefined) {
          switch (action.type) {
            case "snapshot": break;
            case "run_code": await this.runCode(tab, action.code); break;
            case "navigate": await this.effect(tab, () => tab.page.goto(action.url, { waitUntil: "domcontentloaded" })); break;
            case "click":
              await tab.page.bringToFront();
              await this.effect(tab, () => tab.page.getByRef(action.element_ref).click()); break;
            case "fill": {
              await tab.page.bringToFront();
              const locator = tab.page.getByRef(action.element_ref);
              const role = tab.refs.get(action.element_ref);
              if (role === "combobox") await this.effect(tab, () => locator.selectOption({ label: action.value }));
              else if (role === "checkbox" || role === "radio" || role === "switch") {
                if (action.value !== "true" && action.value !== "false") return { type: "failed", session_id, message: "Toggle fill requires true or false." };
                await this.effect(tab, () => locator.setChecked(action.value === "true"));
              } else await this.effect(tab, () => locator.fill(action.value));
              break;
            }
            case "press_key":
              await tab.page.bringToFront();
              await this.effect(tab, () => tab.page.keyboard.press(action.key)); break;
            case "wait_for": await tab.page.getByText(action.text, { exact: false }).first().waitFor({ state: "visible" }); break;
            default: throw new Error("Unsupported browser action");
          }
        } else if (action.type !== "snapshot") return { type: "failed", session_id, message: "Handle the owned tab's current dialog before another action." };
      }
      await this.refresh();
      const result = await this.state(tab, "Current Chrome page state.");
      this.liveBrowser();
      return { type: "ready", session_id, tabs: this.tabs(), output: result, is_error: false };
    } catch (error) {
      if (action.type === "run_code" && !this.closing && !this.disconnected) {
        const timer = new AbortController();
        try {
          if ([...this.owned.values()].some(tab => tab.dialog !== undefined)) throw new Error("Password capture is blocked by a dialog");
          await Promise.race([Promise.all([...this.owned.values()].map(tab => this.capturePasswords(tab))),
            delay(1000, undefined, { signal: timer.signal, ref: false }).then(() => {
              throw new Error("Password capture after script failure timed out");
            })]);
        } catch { this.captureFailed = true; } finally { timer.abort(); }
      }
      if (this.captureFailed) return { type: "uncertain", session_id,
        message: this.failureDetail(error) + " Browser output was withheld because password capture could not be verified. Earlier effects were not replayed; inspect Chrome before continuing." };
      if (action.type === "run_code") {
        const detail = this.closing || this.disconnected ? "The script did not confirm completion"
          : error instanceof Error ? error.message : object(error) && typeof error.message === "string"
          ? error.message : "The script did not confirm completion";
        return { type: "uncertain", session_id,
          message: `${this.failureDetail(error)} Playwright code failed: ${this.redact(detail).slice(0, 8192)}. Earlier effects were not replayed. Inspect the page before running it again; native tab cleanup was not verified.` };
      }
      const recovery = this.config.debugging_port === undefined || this.config.debugging_port === null
        ? "Confirm the Playwright extension is installed in the configured profile and its pairing token is available to Agent."
        : "Confirm the configured Chrome is running with its native debugging port enabled.";
      return { type: mutates(action) ? "uncertain" : "disconnected", session_id,
        message: `${this.failureDetail(error)} Chrome did not confirm this operation. Native tabs may still be open and cleanup was not verified. Inspect its outcome before repeating it. ${recovery} Old handles are invalid after disconnection.` };
    }
  }

  private async closeTab(tab: OwnedTab): Promise<void> {
    const dialogs: Promise<void>[] = [];
    const handle = (dialog: Dialog): void => {
      // Release discards positively owned disposable pages. Allow beforeunload
      // to finish closing them; dismiss an existing alert/confirm/prompt.
      const pending = (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss())
        .then(() => this.dialogClosed(tab, dialog));
      dialogs.push(pending);
      void pending.catch(() => {});
    };
    tab.page.on("dialog", handle);
    try {
      if (tab.page.isClosed()) throw new Error("Owned page lost control before cleanup");
      tab.closing = true;
      if (tab.dialog !== undefined) handle(tab.dialog);
      const closed = tab.page.waitForEvent("close", { timeout: ACTION_TIMEOUT });
      // Require a native command acknowledgement and its close event. Default
      // Page.close suppresses TargetClosedError, including debugger detach.
      await Promise.all([tab.page.close({ runBeforeUnload: true }), closed]);
      await Promise.all(dialogs);
      const client = this.client;
      if (client !== undefined) await client.ping({ timeoutMs: 5000 });
      else {
        const session = await this.liveBrowser().newBrowserCDPSession();
        try { await session.send("Browser.getVersion"); } finally { await session.detach(); }
      }
      this.owned.delete(tab.info.id);
    } finally { tab.closing = false; tab.page.off("dialog", handle); }
  }

  private async release(session_id: string): Promise<BrowserResponse> {
    try {
      for (const tab of [...this.owned.values()]) await this.closeTab(tab);
      return { type: "closed", session_id, tabs: this.tabs(),
        output: output("Owned tabs were closed and the Chrome connection was released.") };
    } catch (error) {
      return { type: "uncertain", session_id, message: `${this.failureDetail(error)} Owned tab cleanup could not be confirmed. Inspect Chrome before closing or repeating anything.` };
    } finally { await this.close(); }
  }
}

async function main(): Promise<void> {
  const rawConfig: unknown = JSON.parse(process.argv[2] ?? "{}");
  if (!object(rawConfig) || rawConfig.user_data_dir !== null && typeof rawConfig.user_data_dir !== "string"
      || rawConfig.profile_dir_name !== null && typeof rawConfig.profile_dir_name !== "string"
      || rawConfig.debugging_port !== undefined && rawConfig.debugging_port !== null
        && (typeof rawConfig.debugging_port !== "number" || !Number.isInteger(rawConfig.debugging_port)
          || rawConfig.debugging_port < 1 || rawConfig.debugging_port > 65535)
      || rawConfig.secret_environment !== undefined && (!Array.isArray(rawConfig.secret_environment)
        || !rawConfig.secret_environment.every((name: unknown) => typeof name === "string"
          && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== "OP_SERVICE_ACCOUNT_TOKEN"))) throw new Error("Invalid browser configuration");
  const host = new BrowserHost({ user_data_dir: rawConfig.user_data_dir, profile_dir_name: rawConfig.profile_dir_name,
    debugging_port: rawConfig.debugging_port ?? null, secret_environment: rawConfig.secret_environment ?? [] });
  const ajv = new Ajv2020({ strict: true });
  ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat("uint32", { type: "number", validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff });
  const schema: unknown = JSON.parse(await readFile(new URL("../../src/generated/browser.schema.json", import.meta.url), "utf8"));
  if (!object(schema)) throw new Error("Invalid browser request schema");
  const valid = ajv.compile<BrowserRequest>(schema);
  const stop = () => { void host.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  process.stdin.once("end", () => { void host.close(); });
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      const request: unknown = JSON.parse(line);
      if (!valid(request)) throw new Error("Invalid browser request");
      const reply = await host.execute(request);
      process.stdout.write(JSON.stringify(reply) + "\n");
    }
  } finally { await host.close(); }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(() => { process.exitCode = 1; });
}
