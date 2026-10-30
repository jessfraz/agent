import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("playwright-core/package.json");
const metadata = JSON.parse(await readFile(packagePath, "utf8"));
if (metadata.version !== "1.64.1") {
  throw new Error("Review the native CDP initialization patch for this Playwright version");
}

// noDefaults connects to an externally owned browser. Prepare context bindings
// before attaching any renderers, so later Page bindings do not walk a stalled
// existing page. Every frame installs the binding during its own initialization.
// Skip only the global existing-page barrier; new Pages still await their own
// initialization and existing Pages become available normally when ready.
const patches = [
  {
    original: "\n        try {\n          await Promise.all([\n            session.send(\"Target.setAutoAttach\", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })",
    patched: "\n        try {\n          if (options.noDefaults)\n            await browser._defaultContext.exposePlaywrightBindingIfNeeded();\n          await Promise.all([\n            session.send(\"Target.setAutoAttach\", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })",
  },
  {
    original: "\n          await browser._waitForAllPagesToBeInitialized();\n",
    patched: "\n          if (!options.noDefaults)\n            await browser._waitForAllPagesToBeInitialized();\n",
  },
  {
    // CDP broadcasts binding calls to every subscribed client. An external
    // browser connection must leave another client's callback unanswered.
    original: "\n          const binding = page.getBinding(name);\n          if (!binding)\n",
    patched: "\n          const binding = page.getBinding(name);\n          if (!binding && page.browserContext._browser.options.noDefaults)\n            return;\n          if (!binding)\n",
  },
];
const bundlePath = join(dirname(packagePath), "lib", "coreBundle.js");
const source = await readFile(bundlePath, "utf8");
let result = source;
for (const { original, patched } of patches) {
  const occurrences = value => result.split(value).length - 1;
  if (occurrences(patched) === 1 && occurrences(original) === 0) {
    continue; // Rebuilding without reinstalling dependencies is supported.
  }
  if (occurrences(original) !== 1 || occurrences(patched) !== 0) {
    throw new Error("Playwright native CDP patch context changed; review before building");
  }
  result = result.replace(original, patched);
}
if (result !== source) await writeFile(bundlePath, result);
