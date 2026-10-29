import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

// Test-only artifacts. Production connects to the user's installed Chrome.
const extensionId = "mmlmfjhmonkocbjadbfplnigmagldckm";
const extensionVersion = "0.4.0";
const extensionSha256 = "e012b45f6170f627d275588ca1a37dffe5919c2635bbac512f11b74930e63835";
const extensionUrl = "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=156.0.8078.49&acceptformat=crx3&x=id%3Dmmlmfjhmonkocbjadbfplnigmagldckm%26uc";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const parent = process.argv[2];
  if (parent === undefined) throw new Error("Pass an ignored local directory or CI temporary directory for browser fixtures");
  const chrome = chromium.executablePath();
  if (!(await stat(chrome).catch(() => undefined))?.isFile()) {
    throw new Error("Install the pinned test browser first: node runtime/node_modules/playwright-core/cli.js install chromium");
  }
  await mkdir(resolve(parent), { recursive: true });
  const directory = await mkdtemp(join(resolve(parent), "agent-browser-"));
  const extension = join(directory, "extension");
  try {
    const response = await fetch(extensionUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("Official extension download failed with HTTP " + response.status);
    const crx = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(crx).digest("hex") !== extensionSha256) {
      throw new Error("Official extension checksum changed; review and update the pinned test fixture");
    }
    if (crx.length < 12 || crx.subarray(0, 4).toString("ascii") !== "Cr24" || crx.readUInt32LE(4) !== 3) {
      throw new Error("Expected a CRX3 extension archive");
    }
    const offset = 12 + crx.readUInt32LE(8);
    if (offset >= crx.length) throw new Error("Invalid CRX3 archive header");
    const archive = join(directory, "extension.zip");
    await writeFile(archive, crx.subarray(offset));
    await mkdir(extension);
    await promisify(execFile)("unzip", ["-q", archive, "-d", extension], { timeout: 15_000 });
    // Chrome rejects Store verification metadata in a normally loaded unpacked
    // fixture. All executable assets remain identical to the verified CRX.
    await rm(join(extension, "_metadata"), { recursive: true, force: true });
    await rm(archive);
    const manifest: unknown = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
    if (!object(manifest) || manifest.version !== extensionVersion || typeof manifest.key !== "string") {
      throw new Error("Official extension manifest does not match the pinned version");
    }
    const actualId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)]
      .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
    if (actualId !== extensionId) throw new Error("Official extension identity does not match");
    const environment = {
      AGENT_TEST_CHROME: chrome,
      AGENT_TEST_PLAYWRIGHT_EXTENSION_DIR: extension,
    };
    if (process.env.GITHUB_ENV !== undefined) {
      await appendFile(process.env.GITHUB_ENV, Object.entries(environment).map(([name, value]) => name + "=" + value + "\n").join(""));
    }
    process.stdout.write(JSON.stringify(environment) + "\n");
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

void main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
