import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation, type ConversationId, type DocumentReader, type EntryId, type EntryRecord,
  type Harness, type JsonObject, type Session } from "@earendil-works/pi-durable";
import type { TranscriptAnnotation } from "./generated/TranscriptAnnotation.js";
import type { TranscriptClassification } from "./generated/TranscriptClassification.js";

type HiddenClassification = Exclude<TranscriptClassification, "visible">;
export type TranscriptVisibilityState = { entries: Record<string, HiddenClassification> };
export const TranscriptVisibility = defineDoc<TranscriptVisibilityState>({ kind: "agent.transcript.visibility", scope: "conversation",
  history: "latest", fork: "initial", version: 1, initial: () => ({ entries: {} }), checkpointWhen: () => true });
export class TranscriptAnnotationError extends Error {}

export function transcriptVisible(entryId: string, state: Readonly<TranscriptVisibilityState> | null | undefined): boolean {
  return state?.entries[entryId] === undefined;
}
export async function readTranscriptVisibility(reader: DocumentReader, conversation: ConversationId): Promise<Readonly<TranscriptVisibilityState> | undefined> {
  return reader.snapshot(TranscriptVisibility, conversation, BACKGROUND_CONTEXT);
}
function nativeId(value: unknown): value is EntryId { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function parsedId(value: string): EntryId {
  const id: unknown = Number(value);
  if (!nativeId(id) || id.toString() !== value) throw new TranscriptAnnotationError("Transcript entry IDs must be positive native integers.");
  return id;
}

/** Classification changes presentation only. The immutable entry and model context stay intact. */
export async function annotateTranscript(session: Harness, conversation: Conversation, annotations: readonly TranscriptAnnotation[]): Promise<TranscriptAnnotation[]> {
  if (annotations.length < 1 || annotations.length > 256) throw new TranscriptAnnotationError("Annotate between 1 and 256 transcript entries at once.");
  const entries = annotations.map((annotation) => ({ ...annotation, id: parsedId(annotation.entry_id) }));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new TranscriptAnnotationError("Transcript entry IDs must be distinct.");
  await session.commit(async (tx) => {
    const owners = new Map<ConversationId, number>();
    let current = await tx.conversation(conversation.id), through = Infinity;
    while (current !== undefined) {
      owners.set(current.id, through);
      if (current.parent === undefined) break;
      through = Math.min(through, current.parent.at);
      current = await tx.conversation(current.parent.conversationId);
    }
    for (const entry of entries) {
      const original = await tx.entry(entry.id), boundary = original === undefined ? undefined : owners.get(original.conversationId);
      if (original === undefined || boundary === undefined || original.id > boundary) {
        throw new TranscriptAnnotationError("A transcript entry does not belong to the selected conversation history.");
      }
    }
    const state = await tx.doc(TranscriptVisibility, conversation.id);
    for (const entry of entries) {
      if (entry.classification === "visible") delete state.entries[entry.entry_id];
      else state.entries[entry.entry_id] = entry.classification;
    }
  }, BACKGROUND_CONTEXT);
  return annotations.map((annotation) => ({ ...annotation }));
}

function visibilityState(value: JsonObject | null): value is TranscriptVisibilityState {
  return value !== null && value.entries !== null && typeof value.entries === "object" && !Array.isArray(value.entries) &&
    Object.values(value.entries).every((classification) => classification === "internal_receipt" || classification === "maintenance_control");
}

/** Own the initial read and commit subscription together, including entries committed during acquisition. */
export async function observeTranscriptVisibility(session: Session, conversation: ConversationId,
  onEntry?: (entry: EntryRecord, state: Readonly<TranscriptVisibilityState> | undefined) => void): Promise<{
    state(): Readonly<TranscriptVisibilityState> | undefined; close(): void;
  }> {
  let state: Readonly<TranscriptVisibilityState> | undefined, observed = false, ready = false;
  const pending: EntryRecord[] = [];
  const stop = session.subscribeCommits((publication) => {
    for (const change of publication.changes) if (change.type === "document" && change.record.kind === TranscriptVisibility.definition.kind &&
      change.conversationId === conversation) {
      observed = true;
      state = visibilityState(change.value) ? change.value : undefined;
    }
    if (onEntry !== undefined) for (const change of publication.changes) if (change.type === "entry" && change.value.conversationId === conversation) {
      if (ready) onEntry(change.value, state);
      else pending.push(change.value);
    }
  });
  try {
    const initial = await readTranscriptVisibility(session, conversation);
    if (!observed) state = initial;
    ready = true;
    for (const entry of pending) onEntry?.(entry, state);
    pending.length = 0;
    return { state: () => state, close: stop };
  } catch (error) { stop(); throw error; }
}
