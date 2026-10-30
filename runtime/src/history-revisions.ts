import { defineDocFamily, defineEntry, type EntryId } from "@earendil-works/pi-durable";

export type RevisionStatus = "superseded" | "ambiguous";
export type SourceSnapshot = { host_id: string; version: string; sequence: number };
export type SourceCapture = { thread_id: string; attempt: number; snapshot: SourceSnapshot; phase: "advertised" | "read" };
export type CaptureState = Pick<SourceCapture, "attempt" | "phase">;
export const REVISION_FORMAT = 2;
export type RevisionView = { watermark: EntryId | null; ready: boolean; entries: Readonly<Record<string, RevisionStatus>> };
export const REVISION_PENDING = "Historical revision coverage is unverified for this snapshot; retained variants may overlap.";
export const REVISION_AMBIGUOUS = "Conflicting historical revisions have equal or unverified source timestamps; no newer version is established.";
export const HistoryObservation = defineEntry<{ updated_at: number; entry_ids: EntryId[]; snapshot?: SourceSnapshot }>("agent.history.observation");
export const HistoryRevisions = defineDocFamily<{ watermark: EntryId | null; entries: Record<string, RevisionStatus>; format?: number }, null>({
  kind: "agent.history.revisions", scope: "session", family: true, version: 1,
  initial: () => ({ watermark: null, entries: {} }), checkpointWhen: () => true,
});
type Freshness = { state: "observed"; at: number } | { state: "unverified"; upper: number | null; observed: number | null };
type Candidate = { id: EntryId; key: string; freshness: Freshness; unscoped: number | null; snapshots: Map<string, { at: number; sequence: number }> };
type ItemIdentity = { id: string; turn_id: string; kind: string };
export type RevisionPlan = { groups: Map<string, Candidate[]>; observations: EntryId[]; changes: Map<string, RevisionStatus | undefined> };
function timestamp(value: number | undefined): number | null { return value !== undefined && Number.isSafeInteger(value) ? value : null; }
function observe(value: Freshness, at: number): Freshness {
  if (value.state === "observed") return { state: "observed", at: Math.max(value.at, at) };
  if (value.upper !== null && at >= value.upper) return { state: "observed", at };
  return { ...value, observed: value.observed === null ? at : Math.max(value.observed, at) };
}
function observeCandidate(candidate: Candidate, at: number, snapshot?: SourceSnapshot): void {
  candidate.freshness = observe(candidate.freshness, at);
  if (snapshot === undefined) candidate.unscoped = candidate.unscoped === null ? at : Math.max(candidate.unscoped, at);
  else {
    const previous = candidate.snapshots.get(snapshot.host_id);
    if (previous === undefined || at > previous.at || (at === previous.at && snapshot.sequence > previous.sequence)) {
      candidate.snapshots.set(snapshot.host_id, { at, sequence: snapshot.sequence });
    }
  }
}
function sameObservation(left: Candidate, right: Candidate): boolean {
  return JSON.stringify(left.freshness) === JSON.stringify(right.freshness) && left.unscoped === right.unscoped &&
    JSON.stringify([...left.snapshots]) === JSON.stringify([...right.snapshots]);
}
function decisions(group: readonly Candidate[]): Map<string, RevisionStatus | undefined> {
  let known: number | null = null;
  for (const { freshness } of group) {
    const point = freshness.state === "observed" ? freshness.at : freshness.observed;
    if (point !== null) known = known === null ? point : Math.max(known, point);
  }
  const hosts = new Map<string, number>();
  for (const candidate of group) for (const [host, point] of candidate.snapshots) if (point.at === known) {
    hosts.set(host, Math.max(hosts.get(host) ?? 0, point.sequence));
  }
  const remaining = group.filter(({ freshness, snapshots, unscoped }) => {
    const upper = freshness.state === "observed" ? freshness.at : freshness.upper;
    if (known === null || upper === null || upper > known) return true;
    if (upper < known) return false;
    if (freshness.state === "unverified" || unscoped === known) return true;
    return [...snapshots].some(([host, point]) => point.at === known && point.sequence === hosts.get(host));
  });
  const current = new Set(remaining.map((candidate) => candidate.id));
  return new Map(group.map((candidate) => [candidate.id.toString(), !current.has(candidate.id) ? "superseded" : remaining.length > 1 ? "ambiguous" : undefined]));
}
/** Source observations establish freshness; native append order never does. */
export class RevisionTracker {
  private readonly groups = new Map<string, Candidate[]>();
  private readonly entries = new Map<EntryId, Candidate>();
  private upper: number | null = null;
  metadata(value: number): void { const at = timestamp(value); if (at !== null) this.upper = this.upper === null ? at : Math.max(this.upper, at); }
  add(id: EntryId, item: ItemIdentity, value?: number, snapshot?: SourceSnapshot): void {
    if (this.entries.has(id)) return;
    const at = timestamp(value), key = JSON.stringify([item.turn_id, item.kind, item.id]);
    // Old page receipts did not bind items to an observation. Preceding source
    // metadata supplies only an upper bound, never proof that a version is newer.
    const candidate: Candidate = { id, key, freshness: at === null ? { state: "unverified", upper: this.upper, observed: null } : { state: "observed", at },
      unscoped: snapshot === undefined ? at : null, snapshots: new Map() };
    if (at !== null && snapshot !== undefined) observeCandidate(candidate, at, snapshot);
    const group = this.groups.get(key) ?? []; group.push(candidate); this.groups.set(key, group); this.entries.set(id, candidate);
  }
  observe(ids: readonly EntryId[], value: number, snapshot?: SourceSnapshot): void {
    const at = timestamp(value); if (at === null) return;
    for (const id of ids) { const candidate = this.entries.get(id); if (candidate !== undefined) observeCandidate(candidate, at, snapshot); }
  }
  plan(added: readonly { id: EntryId; item: ItemIdentity }[], observed: readonly EntryId[], value: number, snapshot?: SourceSnapshot): RevisionPlan {
    const groups = new Map<string, Candidate[]>(), observations: EntryId[] = [], at = timestamp(value);
    const group = (key: string) => { let values = groups.get(key); if (values === undefined) { values = (this.groups.get(key) ?? []).map((candidate) => ({ ...candidate, snapshots: new Map(candidate.snapshots) })); groups.set(key, values); } return values; };
    for (const addition of added) {
      const key = JSON.stringify([addition.item.turn_id, addition.item.kind, addition.item.id]);
      const candidate: Candidate = { id: addition.id, key, freshness: at === null ? { state: "unverified", upper: null, observed: null } : { state: "observed", at },
        unscoped: snapshot === undefined ? at : null, snapshots: new Map() };
      if (at !== null && snapshot !== undefined) observeCandidate(candidate, at, snapshot);
      group(key).push(candidate);
    }
    if (at !== null) for (const id of new Set(observed)) {
      const candidate = this.entries.get(id); if (candidate === undefined) continue;
      const target = group(candidate.key).find((value) => value.id === id);
      if (target !== undefined) { observeCandidate(target, at, snapshot); if (!sameObservation(target, candidate)) observations.push(id); }
    }
    const changes = new Map<string, RevisionStatus | undefined>();
    for (const values of groups.values()) for (const [id, status] of decisions(values)) changes.set(id, status);
    return { groups, observations, changes };
  }
  apply(plan: RevisionPlan): void {
    for (const [key, values] of plan.groups) { this.groups.set(key, values); for (const value of values) this.entries.set(value.id, value); }
  }
  projection(): Record<string, RevisionStatus> {
    const result: Record<string, RevisionStatus> = {};
    for (const group of this.groups.values()) if (group.length > 1) for (const [id, status] of decisions(group)) if (status !== undefined) result[id] = status;
    return result;
  }
}
export function revisionStatus(id: EntryId, view: RevisionView): RevisionStatus | "current" | "pending" | "outside_snapshot" {
  if (!view.ready) return "pending";
  if (view.watermark === null || id > view.watermark) return "outside_snapshot";
  return view.entries[id.toString()] ?? "current";
}
