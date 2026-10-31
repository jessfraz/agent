import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { mutatePublished, type SearchMutation } from "./search-mutations.js";
import type { SearchWork, SearchReply } from "./search.js";

const location: { path: string; extension: string; cancellation: SharedArrayBuffer } = workerData;
const cancellation = new Int32Array(location.cancellation);
if (parentPort === null) throw new Error("History publication requires its owner");
const owner = parentPort;
const database = new DatabaseSync(location.path, { allowExtension: true });
database.loadExtension(location.extension); database.enableLoadExtension(false);
database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA mmap_size=0");
owner.on("message", (request: SearchWork<SearchMutation>) => {
  let reply: SearchReply<void>;
  try { mutatePublished(database, request.input, () => Atomics.load(cancellation, 0) !== 0); reply = { id: request.id, type: "result", result: undefined }; }
  catch (error) { reply = { id: request.id, type: "failed", message: error instanceof Error ? error.message : "History publication failed" }; }
  owner.postMessage(reply);
});
owner.once("close", () => database.close());
