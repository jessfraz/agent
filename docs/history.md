# History import and retrieval

Conversations survive closed Rex sessions. Keyword and local semantic search
find related history; import does not create work or revive old instructions.

```sh
agent import codex                  # all registered online hosts
agent import codex --host desktop   # one announced host name
agent import status
agent history search "fabrication files"
agent history search "ERR_SURFACE_413" --mode keyword
agent history read CONVERSATION_ID
agent history open CONVERSATION_ID
```

Run import again to catch up. Completed reliable source versions are skipped;
partial reads resume their committed cursor. Interrupted or failed indexing
resumes from the retained corpus before the next fresh import. Explicit
`--host` selection starts a fresh walk of those hosts when no import is active.
Concurrent commands join the running import; closing its CLI leaves it running.
The same native thread
and item versions are retained once across hosts. Neither importing nor
searching opens Rex sessions. Opening a historical conversation adopts it into
one task using current settings, then opens its named interactive session.

```text
  registered online hosts
  Codex read-only history
            |
    checkpointed import
            |
    Pi conversations + private assets       authoritative
            |
    incremental indexing
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

The `agent import codex` command gathers history from registered,
online hosts through their existing worker connections. It reports checkpointed
progress and unavailable hosts; no copied host inventory or model run is needed.
Use the installed Codex app-server's read-only APIs. Page `thread/list` for
active and archived threads with every native `sourceKinds` value explicitly
selected; omission includes only interactive sources. Read metadata with
`thread/read`, then use full turn/item pagination where supported, or the
installed full-history read. Thread IDs establish identity; filenames and
directories are locators, not thread IDs or assumptions about which threads
are roots.

Rust owns a small `HistorySource` trait for enumeration, transcript reads and
asset reads. Codex is its first implementation. Rust also owns import records
and provenance types, generating TypeScript bindings for the Pi adapter.
Cloud-only or Dot history needs a separately verified export path; local Codex
access does not establish access to those conversations.

The same Codex ID imports idempotently across machines. Retain source versions,
item IDs and real fork relationships. Divergent versions remain distinguishable;
similar topics never merge conversations. Record incomplete reads as gaps and
resume from committed checkpoints without duplicating entries.

Missing or deleted attachments leave explicit gaps while available message text
still imports. Later runs can recover files without repeating the message.
An unavailable full payload remains incomplete; its excerpt is not a substitute
for the original.

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
assets privately on the coordinator, including large cold payloads. A
path on an unavailable source machine is insufficient. Materialize and verify
assets before committing references; record missing payloads. Historical tool
calls are evidence, never replayed. Render these data entries alongside Pi
model messages.

## One derived search index

Use one SQLite file for main, task, worker and imported conversation chunks,
source references,
FTS5 and `sqlite-vec` vectors. Pi remains authoritative. Commit Pi first, then
atomically update derived rows and their indexing checkpoint. Per-conversation
watermarks and dirty index rows support catch-up and rebuilding. Pi commit
subscriptions only enqueue work; they must not await or re-enter a Session.
Completed embedding batches survive interruptions privately. Only a complete
conversation generation replaces the published index; retries reuse its vectors.
Identical text reuses published vectors across conversations while retaining
each entry's identity and provenance.
Startup reconciliation compares conversation tails with saved watermarks, so
missed notifications cannot permanently hide a conversation. Internal feed
judgment transcripts are retained in Pi but are not retrieval candidates.
Search reads published results while an owned import catches up; it reports
incomplete coverage rather than waiting for a full corpus rebuild.

Keep useful user/assistant text and bounded meaningful tool content searchable.
Respect message boundaries and retain entry/asset provenance for every chunk.
Debug logs, repeated boilerplate and arbitrary tool dumps are not useful index
content. Generated image bytes stay in retained evidence, outside search text.
A conversation may need many chunks; conversation count is not vector
count. Avoid indexing only generated summaries, which can omit the needed fact.

Independently retrieve exact source links, FTS matches and dense neighbors.
Exact source references rank first. Semantic search is the default; keyword
mode prioritizes literal identifiers, paths and errors. The other channel breaks
ties, fills remaining slots and provides fallback when inference is unavailable.
Never restrict dense search to FTS matches. Group results by conversation and
read bounded original excerpts from the strongest candidates.
Several conversations can inform one task; similarity does not authorize
merging them or changing state.
An unavailable embedding runner is a retrieval gap, not "no related work."

Automatic chat context reads published keyword matches and current task
metadata without waiting for corpus indexing. The agent can use semantic search
for deeper matching. Esc cancels a pending embedding lookup; completed import
batches remain saved.

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

The Nix installation pins Qwen3-Embedding-0.6B Q8_0, llama.cpp and sqlite-vec.
A service-owned llama.cpp child stays warm and listens on a private Unix socket.
There is no separate daemon to configure or external embedding request. The
1024-dimensional vectors use last-token pooling, normalization and the model's
query instruction. The model download is about 610 MiB; initial indexing also
needs CPU/GPU time and private disk space proportional to the retained corpus.

An optional OpenAI API implementation can use the same trait later. ChatGPT plan
sign-in does not supply documented embeddings API access; API credentials and
billing are separate. Keep inference and embedding configuration independent.

## Rex shows active execution

Closing a whole Rex session preserves its task and conversation. When related
work continues, inspect that exact session and reuse it, even when Rex's live
session list omits it. An exited terminal can reopen in the same folder. Only
an explicit session-not-found response permits a replacement folder, after
fencing the old allocation. A transport or permission failure retains ownership.

Reopening restores saved messages, pending inputs and task settings. Recent
history loads first; older pages remain available through `/history`. It does
not create a duplicate conversation or submit old messages to the model.
Imported history gets its first task/session only on adoption. Cross-host
transfer remains separate. Reconcile uncertain effects before retrying.

## Validation and scope

The index uses independent exact-reference, FTS and dense retrieval. An embedding
failure still permits lexical results and reports the semantic coverage gap.
`sqlite-vec` uses exact scans. Larger-corpus latency and recall need measurement
before adding an approximate index or tuning the chunker.

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
