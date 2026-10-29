import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { McpClient, StdioTransport, type CallToolResult } from "@earendil-works/pi-mcp";
import type { BrowserAction } from "./generated/BrowserAction.js";
import type { BrowserConfig } from "./generated/BrowserConfig.js";
import type { BrowserReply } from "./generated/BrowserReply.js";
import type { BrowserRequest } from "./generated/BrowserRequest.js";
import type { BrowserResponse } from "./generated/BrowserResponse.js";
import type { BrowserTab } from "./generated/BrowserTab.js";

const OUTPUT_LIMIT = 64 * 1024;
const TOOL_TIMEOUT = 110_000;
const safeArguments = ["--page-id-routing", "--experimental-structured-content", "--no-usage-statistics",
  "--no-performance-crux", "--no-javascript-evaluation", "--no-file-navigations"];

type Page = BrowserTab & { selected: boolean };
type ToolResult = { isError: boolean; reconnected: boolean; pages?: Page[]; openedPages?: Page[];
  snapshot?: Record<string, unknown>; dialog?: { type: string; message: string; defaultValue?: string } };

export type BrowserHostOptions = {
  /** Tests attach the real server to a disposable Chrome instance. */
  serverArguments?: readonly string[];
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePages(value: unknown): Page[] {
  if (!Array.isArray(value)) throw new Error("Invalid browser page list");
  const pages: Page[] = [];
  const ids = new Set<number>();
  for (const item of value) {
    if (!object(item) || typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 1 || item.id > 0xffff_ffff ||
        typeof item.url !== "string" || typeof item.title !== "string" || typeof item.selected !== "boolean" || ids.has(item.id)) {
      throw new Error("Invalid browser page identity");
    }
    ids.add(item.id);
    pages.push({ id: item.id, url: item.url, title: item.title, selected: item.selected });
  }
  return pages;
}

function parseResult(result: CallToolResult): ToolResult {
  if (!object(result.structuredContent)) {
    if (result.isError === true) return { isError: true, reconnected: false };
    throw new Error("Chrome returned no structured result");
  }
  const value = result.structuredContent;
  if (value.reconnected !== undefined && typeof value.reconnected !== "boolean") throw new Error("Invalid reconnect receipt");
  const parsed: ToolResult = { isError: result.isError === true, reconnected: value.reconnected === true };
  if (value.pages !== undefined) parsed.pages = parsePages(value.pages);
  if (value.openedPages !== undefined) parsed.openedPages = parsePages(value.openedPages);
  if (value.snapshot !== undefined) {
    if (!object(value.snapshot)) throw new Error("Invalid browser snapshot");
    parsed.snapshot = value.snapshot;
  }
  if (value.dialog !== undefined) {
    if (!object(value.dialog) || typeof value.dialog.type !== "string" || typeof value.dialog.message !== "string" ||
        value.dialog.defaultValue !== undefined && typeof value.dialog.defaultValue !== "string") throw new Error("Invalid browser dialog");
    parsed.dialog = { type: value.dialog.type, message: value.dialog.message };
    if (typeof value.dialog.defaultValue === "string") parsed.dialog.defaultValue = value.dialog.defaultValue;
  }
  return parsed;
}

function output(message: string, result?: ToolResult): string {
  const text = JSON.stringify({ message, ...(result?.snapshot === undefined ? {} : { snapshot: result.snapshot }),
    ...(result?.dialog === undefined ? {} : { dialog: result.dialog }) });
  const bytes = Buffer.from(text);
  return bytes.length <= OUTPUT_LIMIT ? text : bytes.subarray(0, OUTPUT_LIMIT - 64).toString("utf8") + "\n[Browser output truncated.]";
}

function allowedUrl(value: string): boolean {
  if (value === "about:blank") return true;
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === ""; }
  catch { return false; }
}

function mutates(action: BrowserAction): boolean {
  return action.type !== "status" && action.type !== "snapshot" && action.type !== "wait_for" && action.type !== "retain_tab";
}

/** Owns one conversation's live Chrome connection, never the external browser. */
export class BrowserHost {
  private client: McpClient | undefined;
  private owner: { owner_id: string; session_id: string } | undefined;
  private readonly owned = new Map<number, BrowserTab>();
  private readonly operations = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private disconnected = false;
  private closing = false;

  constructor(private readonly config: BrowserConfig, private readonly options: BrowserHostOptions = {}) {}

  execute(request: BrowserRequest): Promise<BrowserReply> {
    const repeatable = request.action.type === "status" || request.action.type === "snapshot" || request.action.type === "wait_for";
    if (!repeatable && this.operations.has(request.operation_id)) return Promise.resolve({ operation_id: request.operation_id,
      response: { type: "failed", session_id: request.session_id, message: "This browser operation ID was already used; its effect will not run again." } });
    if (!repeatable) this.operations.add(request.operation_id);
    const pending = this.queue.then(async () => ({ operation_id: request.operation_id, response: await this.run(request) }));
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }

  /** EOF and signals disconnect only. Explicit release owns tab cleanup. */
  async close(): Promise<void> {
    this.closing = true;
    await this.client?.close();
    this.client = undefined;
    this.disconnected = true;
  }

  private tabs(): BrowserTab[] { return [...this.owned.values()].map(tab => ({ ...tab })); }

  private async connect(): Promise<McpClient> {
    if (this.client !== undefined) return this.client;
    const manifest = import.meta.resolve("chrome-devtools-mcp/package.json");
    const executable = fileURLToPath(new URL("./build/src/bin/chrome-devtools-mcp.js", manifest));
    const args = this.options.serverArguments ?? ["--auto-connect", "--channel=stable",
      ...(this.config.user_data_dir === null ? [] : ["--user-data-dir", this.config.user_data_dir])];
    const env: Record<string, string> = { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" };
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL"]) {
      const value = process.env[name]; if (value !== undefined) env[name] = value;
    }
    const transport = new StdioTransport({ command: process.execPath, args: [executable, ...args, ...safeArguments],
      inheritEnv: false, env, stderr: "pipe", maxStderrBytes: 4096, maxMessageBytes: 4 * 1024 * 1024 });
    const client = new McpClient({ name: "Agent browser", version: "0.1.0", requestTimeoutMs: TOOL_TIMEOUT });
    client.onClose(() => { this.disconnected = true; this.owned.clear(); });
    this.client = client;
    await client.connect(transport);
    return client;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.connect();
    const result = parseResult(await client.callTool(name, args, { timeoutMs: TOOL_TIMEOUT }));
    if (result.reconnected) {
      this.disconnected = true;
      this.owned.clear();
      throw new Error("Chrome reconnected; old handles are invalid");
    }
    return result;
  }

  private async refresh(): Promise<Page[]> {
    const result = await this.call("list_pages", {});
    if (result.isError) throw new Error("Browser inventory could not be confirmed");
    const pages = result.pages ?? [];
    const live = new Map(pages.map(page => [page.id, page]));
    for (const id of this.owned.keys()) {
      const page = live.get(id);
      if (page === undefined) this.owned.delete(id);
      else this.owned.set(id, { id, url: page.url, title: page.title });
    }
    return pages;
  }

  private adoptPopups(result: ToolResult): void {
    // Upstream emits this list only from the acted-on Page's popup event.
    // A browser inventory difference does not establish ownership.
    for (const page of result.openedPages ?? []) this.owned.set(page.id, { id: page.id, url: page.url, title: page.title });
  }

  private async run(request: BrowserRequest): Promise<BrowserResponse> {
    const { session_id, action } = request;
    if (this.owner === undefined) this.owner = { owner_id: request.owner_id, session_id };
    if (this.owner.owner_id !== request.owner_id || this.owner.session_id !== session_id) {
      return { type: "failed", session_id, message: "This browser connection belongs to another conversation or session." };
    }
    if (this.disconnected || this.closing) return { type: "disconnected", session_id,
      message: "The Chrome connection is closed. Old tab handles are invalid; open a new connection to continue." };
    if ((action.type === "open" || action.type === "new_tab" || action.type === "navigate") && !allowedUrl(action.url)) {
      return { type: "failed", session_id, message: "Browser navigation requires an HTTP or HTTPS URL without embedded credentials, or about:blank." };
    }
    if ("tab_id" in action && !this.owned.has(action.tab_id)) return { type: "failed", session_id,
      message: "This tab is not owned by this browser connection. Read its current tabs before continuing." };
    try {
      if (action.type === "status" && this.client === undefined) return { type: "ready", session_id, tabs: [], output: output("The browser connection has not been opened."), is_error: false };
      if (action.type === "release") return await this.release(session_id);
      const before = await this.refresh();
      if ("tab_id" in action && !this.owned.has(action.tab_id)) return { type: "failed", session_id,
        message: "The owned tab has been closed or removed. Its handle is no longer valid." };
      if (action.type === "status") return { type: "ready", session_id, tabs: this.tabs(), output: output("Current owned Chrome tabs."), is_error: false };
      if (action.type === "retain_tab") {
        this.owned.delete(action.tab_id);
        return { type: "ready", session_id, tabs: this.tabs(), output: output("The result tab was retained for the user and released from disposable task ownership."), is_error: false };
      }

      let result: ToolResult;
      let activeId: number;
      if (action.type === "open" || action.type === "new_tab") {
        result = await this.call("new_page", { url: "about:blank", background: true, timeout: 30_000 });
        if (result.isError) return { type: "uncertain", session_id,
          message: "Chrome did not confirm the new tab. Inspect Chrome before trying again; confirm remote debugging is enabled and its connection dialog was allowed." };
        const selected = (result.pages ?? []).filter(page => page.selected);
        const created = selected[0];
        if (selected.length !== 1 || created === undefined || before.some(page => page.id === created.id)) throw new Error("The new tab's identity was not confirmed");
        activeId = created.id;
        this.owned.set(created.id, { id: created.id, url: created.url, title: created.title });
        // Record a known blank page before navigation can submit or fail.
        if (action.url !== "about:blank") result = await this.call("navigate_page", { pageId: activeId, url: action.url, timeout: 30_000 });
      } else {
        activeId = action.tab_id;
        switch (action.type) {
          case "snapshot": result = await this.call("take_snapshot", { pageId: activeId }); break;
          case "navigate": result = await this.call("navigate_page", { pageId: activeId, url: action.url, timeout: 30_000 }); break;
          case "click": result = await this.call("click", { pageId: activeId, uid: action.element_ref, includeSnapshot: true }); break;
          case "fill": result = await this.call("fill", { pageId: activeId, uid: action.element_ref, value: action.value, includeSnapshot: true }); break;
          case "press_key": result = await this.call("press_key", { pageId: activeId, key: action.key, includeSnapshot: true }); break;
          case "wait_for": result = await this.call("wait_for", { pageId: activeId, text: [action.text], visible: true, timeout: 30_000 }); break;
          case "handle_dialog": result = await this.call("handle_dialog", { pageId: activeId, action: action.accept ? "accept" : "dismiss",
            ...(action.prompt_text === null ? {} : { promptText: action.prompt_text }) }); break;
          case "close_tab": {
            result = await this.call("close_page", { pageId: activeId });
            if (result.isError) throw new Error("Chrome did not confirm closing the tab");
            await this.refresh();
            return { type: "ready", session_id, tabs: this.tabs(), output: output(this.owned.has(activeId)
              ? "Chrome retained the tab; the final open page cannot be closed." : "The owned tab was closed."), is_error: this.owned.has(activeId) };
          }
          default: throw new Error("Unsupported browser action");
        }
      }
      this.adoptPopups(result);
      if (result.isError && mutates(action)) return { type: "uncertain", session_id,
        message: "Chrome reported a failure after this action began. It may have partially applied; inspect the current state before repeating it." };
      if (result.snapshot === undefined && result.dialog === undefined && !result.isError) {
        const snapshot = await this.call("take_snapshot", { pageId: activeId });
        if (snapshot.snapshot !== undefined) result.snapshot = snapshot.snapshot;
        if (snapshot.dialog !== undefined) result.dialog = snapshot.dialog;
      }
      await this.refresh();
      return { type: "ready", session_id, tabs: this.tabs(), output: output(result.isError
        ? "Chrome reported a failure. Inspect the current state before repeating the action." : "Current Chrome page state.", result), is_error: result.isError };
    } catch {
      return { type: mutates(action) ? "uncertain" : "disconnected", session_id,
        message: "Chrome did not confirm this operation. Inspect its outcome before repeating it. If disconnected, old tab handles are invalid; open a new connection to continue." };
    }
  }

  private async release(session_id: string): Promise<BrowserResponse> {
    if (this.client === undefined) { await this.close(); return { type: "closed", session_id, tabs: [], output: output("The browser connection was released.") }; }
    try {
      await this.refresh();
      // Exact IDs remain bound to their native target even when another tab is
      // closed or reordered. Never close by list position or by matching a URL.
      for (const id of [...this.owned.keys()]) {
        if ((await this.call("close_page", { pageId: id })).isError) throw new Error("Chrome did not confirm closing an owned tab");
      }
      await this.refresh();
      const tabs = this.tabs();
      return { type: "closed", session_id, tabs, output: output(tabs.length === 0
        ? "Owned tabs were closed and the Chrome connection was released."
        : "The Chrome connection was released with retained tabs. Chrome refuses to close the final open page.") };
    } finally {
      // A failed cleanup is still a terminal connection transition. Keeping a
      // partially disconnected upstream process cannot make its IDs reusable.
      await this.close();
    }
  }
}

async function main(): Promise<void> {
  const rawConfig: unknown = JSON.parse(process.argv[2] ?? "{}");
  if (!object(rawConfig) || rawConfig.user_data_dir !== null && typeof rawConfig.user_data_dir !== "string") throw new Error("Invalid browser configuration");
  const host = new BrowserHost({ user_data_dir: rawConfig.user_data_dir });
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
