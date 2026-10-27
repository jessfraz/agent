# History import and retrieval

Proposal, not implemented. Durable conversations should survive closed Rex
sessions, and relevant history should be found even when its wording differs
from a new message. Import must not create work or revive old instructions.

```text
  registered online hosts
  Codex read-only history
            |
    checkpointed import
            |
    Pi conversations + private assets       authoritative
            |
    queued incremental indexing
            |
    search.sqlite: text + FTS5 + vectors    rebuildable
            |
  exact links / keywords / semantic similarity
            |
    group candidates, read originals
            |
    reuse task / adopt historical conversation
            |
    named Rex session when execution is needed
```

## Import boundary

The proposed `agent import codex` command gathers history from registered,
online hosts through their existing worker connections. It reports checkpointed
progress and unavailable hosts; no copied host inventory or model run is needed.
Use the installed Codex app-server's read-only APIs. Page `thread/list` for
active and archived threads with every native `sourceKinds` value explicitly
selected; omission includes only interactive sources. Read metadata with
`thread/read`, then use full turn/item pagination where supported, or the
installed full-history read. Native fallback reads fill verified gaps using
Codex metadata. Thread IDs establish identity; filenames and directories are
locators, not thread IDs or assumptions about which threads are roots.

Rust owns a small `HistorySource` trait for enumeration, transcript reads and
asset reads. Codex is its first implementation. Rust also owns import records
and provenance types, generating TypeScript bindings for the Pi adapter.
Cloud-only or Dot history needs a separately verified export path; local Codex
access does not establish access to those conversations.

The same Codex ID imports idempotently across machines. Retain source versions,
item IDs and real fork relationships. Divergent versions remain distinguishable;
similar topics never merge conversations. Record incomplete reads as gaps and
resume from committed checkpoints without duplicating entries.

## Native Pi storage, inert history

Create ownerless Pi conversations and append application `data` entries through
ordinary transactions. Commit each batch with its import ledger/checkpoint.
Do not submit inputs or passive submissions: even a submission can resume Pi's
scheduler. Imported entries have no `model` messages, native tool execution,
pending input, task outcome event or Rex binding.

A separate typed `ImportedConversation` record describes historical material.
It is not an open task. Adoption attaches a task to that existing conversation
only when selected work needs continuation. Use current instructions, tools,
authentication and model defaults, with bounded historical excerpts as evidence.
Never import authentication state, system/developer prompts or permission
grants.

Retain available tool arguments/results, structured payloads and referenced
assets privately on the coordinator, including compressed cold material. A
path on an unavailable source machine is insufficient. Materialize and verify
assets before committing references; record missing payloads. Historical tool
calls are evidence, never replayed. Render these data entries alongside Pi
model messages.

## One derived search index

Use one SQLite file for live/imported conversation chunks, source references,
FTS5 and `sqlite-vec` vectors. Pi remains authoritative. Commit Pi first, then
atomically update derived rows and their indexing checkpoint. Per-conversation
watermarks and a durable dirty ledger support catch-up and rebuilding. Pi commit
subscriptions only enqueue work; they must not await or re-enter a Session.
Startup reconciliation compares conversation tails with saved watermarks, so
missed notifications cannot permanently hide a conversation.

Keep useful user/assistant text and bounded meaningful tool content searchable.
Respect message boundaries and retain entry/asset provenance for every chunk.
Debug logs, repeated boilerplate and arbitrary tool dumps are not useful index
content. A conversation may need many chunks; conversation count is not vector
count. Avoid indexing only generated summaries, which can omit the needed fact.

Independently retrieve exact source links, FTS matches and dense neighbors.
Never restrict dense search to FTS matches. Fuse ranked lists, group by
conversation and read bounded original excerpts from the strongest candidates.
Several conversations can inform one task; similarity does not authorize
merging them or changing state.
An unavailable embedding runner is a retrieval gap, not "no related work."

`sqlite-vec` runs inside SQLite, with no external vector service. Pin its stable
release through Nix. The existing Node runtime supports FTS5 and extension
loading without another SQLite driver. A separate derived file isolates index
rebuilds from Pi storage; Chord can also accept a preconfigured Node connection,
so this does not require an upstream storage fork.

## Embeddings

Pi AI 1.4.0 has no public embedding API. Add one narrow Rust `EmbeddingProvider`
trait with query/document purpose and batched text input. Its validated output
carries an embedding-space identity: model revision/digest, dimensions, pooling,
normalization and instruction version. Reject invalid vectors or mixed spaces.
Changing that identity or the chunker version creates a new index generation.

Evaluate Qwen3-Embedding-0.6B GGUF through llama.cpp. Keep the model warm in an
app-owned child under the existing supervisor, reachable only inside the local
application boundary. Do not reload it per query or require a separate
user-managed daemon. Pin the runtime and model digest through installation.
Follow the model's query instructions, last-token pooling and normalization;
choose output dimensions from measured retrieval quality and resource use.

An optional OpenAI API implementation can use the same trait later. ChatGPT plan
sign-in does not supply documented embeddings API access; API credentials and
billing are separate. Keep inference and embedding configuration independent.

## Rex shows active execution

Closing a whole Rex session must preserve its task and conversation. Positively
confirm closure and fence the old worker/allocation before admitting replacement
execution. A disconnected GUI, offline host or missing receipt does not prove
closure. Reconcile uncertain effects before retrying.

When related work later continues, open a clearly named replacement session on
the same online execution host and bind it to the existing task. Retain history,
pending inputs and saved task settings; do not create a duplicate conversation.
Imported history gets its first task/session only on adoption. Cross-host
transfer remains separate. The MVP holds a missing whole-session binding as
uncertain; automatic reopening requires this explicit lifecycle work.

## Validation and scope

Measure the normalized corpus and actual chunk count before sizing vectors.
Benchmark FTS versus hybrid recall, vocabulary mismatch, exact identifiers and
multiple relevant conversations. Measure warm/cold latency, embedding speed,
memory and disk on supported machines, and inspect actual query plans with
representative data. `sqlite-vec` uses exact scans; add no ANN stack until those
measurements justify one. No latency promise follows from a small thread count.

Verify idempotent reruns, fork/version preservation, interrupted import/index
catch-up, offline asset reads, inert old tools and fenced Rex replacement.
Preserve existing automation definitions and prompts. Migrating schedules is a
separate next step; import neither enables schedules nor builds a cron engine.
Learning and instruction changes retain their separate review boundary.

## Upstream references

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [sqlite-vec Node integration](https://alexgarcia.xyz/sqlite-vec/js.html)
- [sqlite-vec stable release](https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9)
- [Qwen embedding model](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)
- [OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
