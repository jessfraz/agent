import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { RuntimeRequest } from "./generated/RuntimeRequest.js";
import type { RuntimeEvent } from "./generated/RuntimeEvent.js";
import type { RuntimeEventKind } from "./generated/RuntimeEventKind.js";
import type { ErrorCode } from "./generated/ErrorCode.js";
import { ChatGptAuth } from "./auth.js";
import { validRequest, validEvent, errorEvent } from "./protocol.js";

const VERSION = 1;
function stateDirectory(): string {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error("State directory is required");
  return directory;
}
const state = stateDirectory();
const auth = new ChatGptAuth(state);

function emit(id: number, event: RuntimeEventKind): void {
  const frame: RuntimeEvent = { version: VERSION, id, event };
  if (!validEvent(frame)) throw new Error("Invalid runtime event");
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function failure(id: number, code: ErrorCode, message: string): void {
  emit(id, { type: "failure", code, message });
}

const models = createModels();
const upstream = openaiProvider();
models.setProvider({
  ...upstream,
  auth: {
    apiKey: {
      name: "ChatGPT plan",
      async resolve() {
        const credential = await auth.credential();
        return { auth: { apiKey: credential.access }, source: "ChatGPT plan" };
      },
    },
  },
});

let harness: Harness | undefined;
async function conversations(): Promise<Harness> {
  if (harness === undefined) {
    const database = await openNodeSqliteDatabase(join(state, "session.sqlite"));
    await database.exec("PRAGMA synchronous = FULL");
    const storage = await SqliteStorage.open(database);
    harness = await Harness.open(storage, { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
  }
  return harness;
}

async function handle(request: RuntimeRequest): Promise<void> {
  const { id, command } = request;
  try {
    switch (command.type) {
      case "login": {
        const status = await auth.login((url) => emit(id, { type: "authorization_url", url }), AbortSignal.timeout(180_000));
        emit(id, { type: "auth_status", status });
        break;
      }
      case "status":
        emit(id, { type: "auth_status", status: await auth.status() });
        break;
      case "logout":
        await auth.logout();
        emit(id, { type: "auth_status", status: await auth.status() });
        break;
      case "chat": {
        await auth.credential();
        const session = await conversations();
        const root = await session.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "openai", modelId: command.model }, instructions: command.instructions } });
        await root.configure({ model: { provider: "openai", modelId: command.model }, instructions: command.instructions }, BACKGROUND_CONTEXT);
        const submission = await root.submit({ type: "input", content: command.input }, BACKGROUND_CONTEXT);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.type !== "input" || settled.status !== "done") {
          failure(id, "provider_unavailable", "The model turn did not complete. Its state is retained.");
          break;
        }
        const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
        const text = entry?.model?.flatMap((message) => {
          if (message.role !== "assistant") return [];
          return message.content.flatMap((item) => item.type === "text" ? [item.text] : []);
        }).join("\n") ?? "";
        emit(id, { type: "answer", conversation_id: root.id.toString(), text });
        break;
      }
    }
  } catch (error) {
    emit(id, errorEvent(error));
  } finally {
    emit(id, { type: "done" });
  }
}

try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request: unknown;
    try { request = JSON.parse(line); } catch {
      failure(0, "invalid_request", "Invalid protocol frame");
      emit(0, { type: "done" });
      continue;
    }
    if (!validRequest(request)) {
      failure(0, "invalid_request", "Invalid protocol frame");
      emit(0, { type: "done" });
      continue;
    }
    if (request.version !== VERSION) {
      failure(request.id, "invalid_request", "Unsupported protocol version");
      emit(request.id, { type: "done" });
      continue;
    }
    await handle(request);
  }
} finally {
  if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
}
