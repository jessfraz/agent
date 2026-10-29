import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { chromium, type Browser, type Dialog, type Page } from "playwright-core";
import type { BrowserAction } from "./generated/BrowserAction.js";
import type { BrowserConfig } from "./generated/BrowserConfig.js";
import type { BrowserReply } from "./generated/BrowserReply.js";
import type { BrowserRequest } from "./generated/BrowserRequest.js";
import type { BrowserResponse } from "./generated/BrowserResponse.js";
import type { BrowserTab } from "./generated/BrowserTab.js";

const OUTPUT_LIMIT = 64 * 1024;
const ACTION_TIMEOUT = 30_000;
const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const exec = promisify(execFile);

export type BrowserHostOptions = {
  /** Tests target only their disposable Chrome profile and isolated registries. */
  serverArguments?: readonly string[];
  extensionToken?: string;
  environment?: Record<string, string>;
};

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
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function output(message: string, state: Record<string, unknown> = {}): string {
  const bytes = Buffer.from(JSON.stringify({ message, ...state }));
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

/** Owns one conversation's extension connection, never the external Chrome. */
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

  constructor(private readonly config: Pick<BrowserConfig, "user_data_dir" | "profile_dir_name">,
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
    try { await this.browser?.close(); } finally {
      await this.client?.close();
      this.client = undefined;
      this.browser = undefined;
      this.disconnected = true;
      this.owned.clear();
    }
  }

  private tabs(): BrowserTab[] { return [...this.owned.values()].map(tab => ({ ...tab.info })); }

  private lost(): void {
    this.disconnected = true;
    this.owned.clear();
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
    const rawToken = this.options.extensionToken ?? process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    // The extension's Copy button includes the environment assignment.
    const token = rawToken?.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, "");
    if (token === undefined || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Chrome extension pairing is not configured");
    if (this.owner === undefined) throw new Error("Browser owner is missing");
    const name = "Agent " + this.owner.session_id;
    const executable = fileURLToPath(new URL("./cli.js", import.meta.resolve("@playwright/mcp/package.json")));
    const args = this.options.serverArguments ?? ["--extension", "--browser", "chrome",
      "--profile-dir-name", this.config.profile_dir_name ?? "Default",
      ...(this.config.user_data_dir === null ? [] : ["--user-data-dir", this.config.user_data_dir])];
    const env = this.childEnvironment(token);
    const transport = new StdioTransport({ command: process.execPath,
      args: [executable, ...args, "--codegen", "none", "--snapshot-mode", "none", "--image-responses", "omit", "--console-level", "error"],
      inheritEnv: false, env, stderr: "pipe", maxStderrBytes: 4096, maxMessageBytes: 4 * 1024 * 1024 });
    const client = new McpClient({ name, version: "0.1.0", requestTimeoutMs: 45_000 });
    this.client = client;
    client.onClose(() => this.lost());
    try {
      await client.connect(transport);
      // Connector URLs contain the token. Keep all bootstrap output, server
      // inventory, upstream errors and stderr out of model output and logs.
      const bootstrap = await client.callTool("browser_tabs", { action: "list" });
      if (bootstrap.isError === true) throw new Error("Chrome extension did not connect");
      const cli = fileURLToPath(new URL("./playwright-cli.js", import.meta.resolve("@playwright/cli/package.json")));
      const { PLAYWRIGHT_MCP_EXTENSION_TOKEN: _token, ...cliEnv } = env;
      const listed = await exec(process.execPath, [cli, "list", "--all", "--json"],
        { env: cliEnv, timeout: 15_000, maxBuffer: 1024 * 1024 });
      const inventory: unknown = JSON.parse(listed.stdout);
      if (!object(inventory) || !Array.isArray(inventory.servers)) throw new Error("Invalid browser server inventory");
      const matches = inventory.servers.filter((server: unknown) => object(server) && server.title === name);
      const descriptor: unknown = matches[0];
      if (matches.length !== 1 || !object(descriptor) || typeof descriptor.endpoint !== "string") throw new Error("Browser endpoint identity was not confirmed");
      const browser = await chromium.connect(descriptor.endpoint, { timeout: 15_000 });
      this.browser = browser;
      browser.on("disconnected", () => this.lost());
      const context = browser.contexts()[0];
      if (context === undefined || browser.contexts().length !== 1) throw new Error("Browser profile context was not confirmed");
      context.setDefaultTimeout(ACTION_TIMEOUT);
      context.setDefaultNavigationTimeout(ACTION_TIMEOUT);
      const connectors = context.pages().filter(page => connector(page, name));
      if (connectors.length !== 1) throw new Error("Browser connector identity was not confirmed");
      // The final attached page disconnects the extension when closed. Create
      // a positively owned page before removing its private connector.
      const page = await context.newPage();
      this.adopt(page);
      await connectors[0]?.close();
      return page;
    } catch {
      await this.close();
      throw new Error("Chrome extension connection failed");
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
      onDialogClosed: dialog => this.dialogClosed(tab, dialog) };
    this.owned.set(tab.info.id, tab);
    page.on("popup", tab.popup);
    page.on("dialog", tab.onDialog);
    page.on("dialogclosed", tab.onDialogClosed);
    page.once("close", () => this.owned.delete(tab.info.id));
    return tab;
  }

  private retain(tab: OwnedTab): void {
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
      if (tab.page.isClosed()) { this.owned.delete(tab.info.id); continue; }
      tab.info.url = tab.page.url();
      // Native modals block page commands, including title and snapshot.
      if (!modal) tab.info.title = await tab.page.title();
    }
  }

  private async state(tab: OwnedTab, message: string): Promise<string> {
    if (tab.dialog !== undefined) return output(message, { dialog: { type: tab.dialog.type(),
      message: tab.dialog.message(), defaultValue: tab.dialog.defaultValue() } });
    const children = await tab.page.locator("body").ariaSnapshotJSON({ mode: "ai" });
    tab.refs.clear();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) { for (const child of node) collect(child); return; }
      if (!object(node)) return;
      if (typeof node.ref === "string" && typeof node.role === "string") tab.refs.set(node.ref, node.role);
      if (Array.isArray(node.children)) for (const child of node.children) collect(child);
    };
    collect(children);
    return output(message, { snapshot: { children } });
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
      message: "The Chrome connection is closed. Old tab handles are invalid; open a new connection to continue." };
    if ((action.type === "open" || action.type === "new_tab" || action.type === "navigate") && !allowedUrl(action.url)) return {
      type: "failed", session_id, message: "Browser navigation requires an HTTP or HTTPS URL without embedded credentials, or about:blank." };
    if ("tab_id" in action && !this.owned.has(action.tab_id)) return { type: "failed", session_id,
      message: "This tab is not owned by this browser connection. Read its current tabs before continuing." };
    if (action.type === "status" && this.client === undefined) return { type: "ready", session_id, tabs: [],
      output: output("The browser connection has not been opened."), is_error: false };
    if (action.type === "release") return this.release(session_id);
    try {
      const firstPage = await this.connect();
      const browser = this.liveBrowser();
      await this.refresh();
      this.liveBrowser();
      if (action.type === "status") return { type: "ready", session_id, tabs: this.tabs(), output: output("Current owned Chrome tabs."), is_error: false };
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
          this.retain(tab);
          return { type: "ready", session_id, tabs: this.tabs(), output: output("The result tab was retained for the user and released from disposable task ownership."), is_error: false };
        }
        if (action.type === "close_tab") {
          await this.closeTab(tab);
          if (this.owned.size === 0) {
            await this.close();
            return { type: "closed", session_id, tabs: [], output: output("The final owned tab was closed and the Chrome connection was released.") };
          }
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
      const result = await this.state(tab, "Current Chrome page state.");
      await this.refresh();
      this.liveBrowser();
      return { type: "ready", session_id, tabs: this.tabs(), output: result, is_error: false };
    } catch {
      return { type: mutates(action) ? "uncertain" : "disconnected", session_id,
        message: "Chrome did not confirm this operation. Inspect its outcome before repeating it. Confirm the Playwright extension is installed in the configured profile and its pairing token is available to Agent. Old handles are invalid after disconnection." };
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
      if (tab.dialog !== undefined) handle(tab.dialog);
      const closed = tab.page.waitForEvent("close", { timeout: ACTION_TIMEOUT });
      // runBeforeUnload receives a native command acknowledgement and does not
      // suppress TargetClosedError like default Page.close(). Require both that
      // acknowledgement and the page event: transport death can fake the event.
      await Promise.all([tab.page.close({ runBeforeUnload: true }), closed]);
      await Promise.all(dialogs);
      const client = this.client;
      if (client === undefined) throw new Error("Browser owner is closed");
      await client.ping({ timeoutMs: 5000 });
      this.owned.delete(tab.info.id);
    } finally { tab.page.off("dialog", handle); }
  }

  private async release(session_id: string): Promise<BrowserResponse> {
    try {
      for (const tab of [...this.owned.values()]) await this.closeTab(tab);
      return { type: "closed", session_id, tabs: this.tabs(),
        output: output("Owned tabs were closed and the Chrome connection was released.") };
    } catch {
      return { type: "uncertain", session_id, message: "Owned tab cleanup could not be confirmed. Inspect Chrome before closing or repeating anything." };
    } finally { await this.close(); }
  }
}

async function main(): Promise<void> {
  const rawConfig: unknown = JSON.parse(process.argv[2] ?? "{}");
  if (!object(rawConfig) || rawConfig.user_data_dir !== null && typeof rawConfig.user_data_dir !== "string"
      || rawConfig.profile_dir_name !== null && typeof rawConfig.profile_dir_name !== "string") throw new Error("Invalid browser configuration");
  const host = new BrowserHost({ user_data_dir: rawConfig.user_data_dir, profile_dir_name: rawConfig.profile_dir_name });
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
