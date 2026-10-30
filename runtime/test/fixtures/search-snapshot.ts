import { constants, DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { readPublished, type PublishedSearch } from "../../src/search.js";

const fixture: { path: string; extension: string; input: PublishedSearch; gate: SharedArrayBuffer } = workerData;
if (parentPort === null) throw new Error("Snapshot fixture needs its owner");
const owner = parentPort, gate = new Int32Array(fixture.gate);
class ObservedDatabase extends DatabaseSync {
  readonly statements: StatementSync[] = [];
  override prepare(sql: string): StatementSync {
    const statement = super.prepare(sql); this.statements.push(statement); return statement;
  }
}
const database = new ObservedDatabase(fixture.path, { readOnly: true, allowExtension: true });
database.loadExtension(fixture.extension); database.enableLoadExtension(false);
let paused = false;
database.setAuthorizer((action, table) => {
  if (!paused && action === constants.SQLITE_READ && table === "chunk_vectors") {
    paused = true; owner.postMessage({ type: "snapshot" });
    if (Atomics.wait(gate, 0, 0, 5000) !== "ok") throw new Error("Owned publisher did not release the native read");
  }
  return constants.SQLITE_OK;
});
try {
  const result = readPublished(database, fixture.input);
  const plans = database.statements.map(statement => ({ sql: statement.sourceSQL,
    plan: database.prepare("EXPLAIN QUERY PLAN " + statement.expandedSQL).all() }));
  let writeRejected = false;
  try { database.exec("CREATE TABLE forbidden_reader_write(value TEXT)"); }
  catch { writeRejected = true; }
  owner.postMessage({ type: "result", result, writeRejected, plans, changes: database.prepare("SELECT total_changes() AS n").get()?.n });
} finally { database.close(); owner.close(); }
