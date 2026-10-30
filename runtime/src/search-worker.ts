import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { readPublished, type SearchReadReply, type SearchReadRequest } from "./search.js";

const location: { path: string; extension: string } = workerData;
if (parentPort === null) throw new Error("Published history reader requires its owner");
const owner = parentPort;
const database = new DatabaseSync(location.path, { readOnly: true, allowExtension: true });
database.loadExtension(location.extension); database.enableLoadExtension(false);
database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; PRAGMA mmap_size=0");
owner.on("message", (request: SearchReadRequest) => {
  let reply: SearchReadReply;
  try { reply = { id: request.id, type: "result", result: readPublished(database, request.input) }; }
  catch (error) { reply = { id: request.id, type: "failed", message: error instanceof Error ? error.message : "Published history read failed" }; }
  owner.postMessage(reply);
});
owner.once("close", () => database.close());
