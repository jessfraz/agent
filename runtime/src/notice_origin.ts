import { defineDoc } from "@earendil-works/pi-durable";
import type { NoticeOrigin } from "./generated/NoticeOrigin.js";

/** Actor-local lineage seeds later continuations and child admission. Notices
 * read the immutable input snapshot, never this mutable admission default. */
export const NoticeLineage = defineDoc<{ origin: NoticeOrigin | null }>({ kind: "agent.notice_lineage", scope: "conversation",
  history: "latest", fork: "initial", version: 1, initial: () => ({ origin: null }), checkpointWhen: () => true });

/** Missing or unusable legacy metadata stays generic. The writer, not text or
 * model-supplied task/source links, supplies the scheduler's identity/title. */
export function readNoticeOrigin(value: unknown): NoticeOrigin | undefined {
  if (value === null || typeof value !== "object" || !("job_id" in value) || !("title" in value) ||
      typeof value.job_id !== "string" || value.job_id.length === 0 || Buffer.byteLength(value.job_id) > 128 ||
      /[\s\p{Cc}]/u.test(value.job_id) || typeof value.title !== "string" || value.title.trim().length === 0) return;
  return { job_id: value.job_id, title: value.title };
}
