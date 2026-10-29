# Architecture

One main conversation is the front door. Task conversations retain their own
history and report concise, actionable results back to it.

```text
  user input / incoming event / due follow-up
                       |
               find related work
              /                 \
       existing task       separate outcome
       reuse conversation  create task record
       and Rex binding     choose online host
              \                 /
            named Rex task session
            + Implementation
            + Review
            + Checks
                       |
           outcome + next actor/check
                       |
              main conversation
```

## MVP ownership

Pi Durable owns conversations, model turns, durable requests and local SQLite
storage. Its existing model/provider interface supplies inference. Rust owns
CLI configuration, generated application contracts, process lifetime, native
host checks, source adapters and filesystem effects. The small TypeScript
adapter connects Pi's transactional documents and tools to those contracts.
Keep that adapter narrow: dependency upgrades use compatibility tests, and an
upstream capability should replace application code when it covers the need.

Rust types generate TypeScript bindings and JSON schemas. The runtime validates
both directions at the wire boundary. Stored resource records describe intent
and evidence; native handles and ownership must be checked again before effects.

New event streams require an explicit client subscription; upgrades preserve
the event shapes accepted by older clients. A chat view reads one canonical
conversation stream. Saved entry IDs identify notices, replies and tools across
live delivery and history replay.

```text
  phone CLI in Rex       CLI / Rex terminal on any host
             \                       /
              +----- agent chat ----+
                          |
                coordinator (macOS or Linux)
                + main conversation
                + Pi Durable / SQLite
                + settings / context repositories
                + source polling / task routing
                          |
                reuse task owner and Rex binding
                choose host only for new work
                          |
          +---------------+----------------+
          | local         | reverse        | reverse
          | effects       | worker link    | worker link
          |               |                |
   desktop (macOS)  laptop (macOS)    server (Linux)
   local Rex        agent -> Rex     agent -> Rex
   + Task A         + Task C         + Task E
   | + Chat         | + Chat         | + Chat
   | + Review       | + Checks       | + Review
   + Task B         + Task D         + Task F
     + Chat           + Chat           + Chat
     + Follow-up      + Investigation  + Profile
```

One selected coordinator is the only writer and source poller. Clients and
workers on any host use that same store. Rex owns terminal/session
lifetime; the coordinator owns application state and routing. Reusing a Rex
connection could replace transport, but would still require this process.
A process lock is inherited by the Pi child, so losing its Rust supervisor does
not admit a second writer.

The supervisor reads Pi events while command writes are pending. One frame owns
its write offset, and the bounded command queue provides backpressure. Shutdown
has an independent signal so a saturated pipe cannot prevent cleanup.

Workers connect to the coordinator and announce their actual Rex host ID,
name, executable and local launch paths. Agent reuses Rex's shared host
inventory when available; each node can announce its own native Rex metadata
even when that inventory is empty. User settings contain one coordinator
address, not a duplicated list of machines. `agent nodes` exposes the registry
and current connections. Saved metadata survives a restart; online status
requires a live connection.

The coordinator runs unqualified main/triage effects locally. Work targeted at
a registered machine travels down that worker's existing connection and uses
its local Rex socket. Unqualified task effects stay on the owning worker.
Main, workers and child agents see the connected host registry; an explicit
`exec` host uses the same coordinator routing without moving task or resource
ownership. Disconnects never silently move an effect onto the coordinator.
Connection generations prevent an old connection's cleanup from removing its
replacement; an unanswered effect is uncertain and is not replayed automatically.

Coordinator TOML owns model defaults, source choices and context repositories.
Clients send their project directory and scoped instructions, without loading
the coordinator's repositories themselves. The coordinator adds global Codex
instructions and context guidance; bounded read/search tools resolve relative
paths against its canonical repository roots. A context repository does not
change the chat's project directory. Node registration refreshes executable
and configuration paths when a task resumes, while preserving that task's
model selection and working directory.
Local clients use a private Unix socket. Remote clients use Tailscale with live
peer identity checks, or an existing SSH connection. With no trust pins,
authorized untagged peers of the same user are accepted. `trusted_nodes` pins
stable node IDs, including tagged servers; `trusted_user_ids` pins human
accounts for their authorized, untagged devices. Either list disables the
default same-user rule. The connected /32 and node owner must match native
WhoIs metadata. See [trust configuration](setup.md#trust).

The SwiftUI iPhone client uses this same coordinator and main conversation.
It loads recent history first and fetches older pages on demand, retaining at
most 500 display rows and 4 MiB of text. A full MagicDNS name is resolved and
validated on each connection. Pending input and immutable attachment copies
stay in a protected, endpoint-specific outbox until admission is acknowledged.

Rust owns the shared attachment types and transfer limits. Files travel in
bounded chunks over the existing authenticated connection, are verified by
SHA-256, and are materialized on the selected execution host. Pi receives its
native image content or a tool-readable file reference. History contains file
metadata; the phone fetches preview bytes only when requested.

The MVP does not replicate the store or recover onto another host. If the
coordinator is down, the client reports that it is unavailable. Copying a live
SQLite database or starting two coordinators is not a recovery mechanism.

## Tasks and Rex

A task has a stable ID, title, intended outcome, source links, summary, pending
inputs and one owning conversation. Its Rex binding records the actual host,
session, window and terminal. Exact provider/account/thread links rank first;
semantic or keyword search retrieves saved conversation text, with task metadata
as a fallback. Read relevant originals before choosing; several conversations
may inform one task. [History](history.md) owns the retrieval details.

Ordinary tasks own a top-level Rex session on their execution host. Child agents
have independent conversations and named terminals inside that same session.
They return results to their parent; the parent returns the outcome to the
main chat. The same task cannot acquire a second active execution. Recent task
activity promotes its session in the host's sidebar.
Feedback repairs reuse a separate repair conversation on the originating host,
with a named terminal in the caller's Rex folder when available. The repair
owns that terminal, not the caller's folder, and reports directly to main.
Follow-ups and refinements of the same broader effort stay in that task;
named child terminals handle bounded subwork. A separate outcome can start a
new top-level task. Private delegation receipts retain the considered
conversation IDs, retrieval gaps and reason for overriding related work.

Task terminals remain interactive after a turn. A single attached actor
serializes replies typed in the terminal and inputs queued by the main agent;
queued work wakes an idle terminal automatically. An idle attachment retains
its execution lease without counting as busy work. New input reacquires
resource guards. Child results return while their tabs remain available for
replies. Main and task CLIs load older history automatically in the background;
reading it does not submit it back to the model. Live
activity exposes tool names and provider-supplied thinking text. OpenAI requests
ask for detailed exposed reasoning; Pi owns streaming and replay state. Clients
retain the returned paragraphs without extracting encrypted state.
Tool inspectors share a read-only runtime lookup anchored to the durable entry
and call ID. It resolves the CLI's selected task or agent through the same scope
as history; native requests remain in main. It bounds the search to 128 nearby
entries and returns at most 32 KiB each of actual arguments and text output.
Unavailable sections and truncation are explicit. History pages retain metadata
without eagerly loading tool bodies.
The Rust TUI renders Markdown with model, reasoning and directory status.
Completed activity groups emit one compact terminal scrollback row. Ctrl+T
opens the retained reasoning and tool details; progress commentary stays prose.
Enter steers, Tab queues a separate turn, and Esc stops the current Pi turn and
drains owned host operations. Tool results remain recorded; stopping cannot
undo an external effect that already completed.

Persist allocation intent before creating a session or terminal. A missing
creation receipt becomes uncertain and requires reconciliation. History sync
must never create an execution. Find matching tasks regardless of process state.
A live worker receives input in its existing terminal. Corrections steer active
work by default; `mode:follow_up` queues a separate turn. The same choice is
available to parent workers when continuing their child agents.
Resuming an existing terminal retains its complete binding through failures and
coordinator restarts. An uncertain resume cannot discard a known folder.
Only an exited process needs a replacement terminal in the same session; close
its old pane after the replacement exists.
Rex server restart recovery remains an open question below.
Closing a whole session is different: positive native absence fences its old
actor before a replacement session is bound to the same task on the same
online host. Failed inspection and offline machines never prove closure.

## Sources and follow-through

```text
  provider read -> atomic event admission + cursor compare-and-swap
                                      |
                               pending source event
                                      |
                      find/read task conversations
                                      |
                    link and continue / dismiss with reason
                                      |
                          verified result or next check
```

Background sources implement a transport-neutral Rust trait in
`sources/mod.rs`, with sibling CLI adapters for mail, calendars, GitHub,
Messages and Slack. CLIs own authentication and refresh. An API adapter, such
as a future Home Assistant source, returns the same normalized events,
checkpoint and coverage. The coordinator rediscovers configured accounts and
polls bounded pages, with separate cursors and coverage per account.
Admit events durably before advancing a cursor. Partial reads never
pretend to be complete, and repeated event versions do not create duplicate
work. Exact triage input survives interrupted requests.

Messages reads use Rex Server's existing macOS permission identity. A short
action starts a headless Rust helper; subsequent calls collect bounded chunks.
The helper owns the read deadline and process group cleanup. Rex retains one
bounded job slot, without creating sessions or terminals. Agent upgrades pass
the current helper path to the same actions and require no new disk-access
grant.

Email replies and due checks enter the same routing path. A tool must durably
link each event to work or dismiss it with a reason; prose alone does not clear
the inbox. A worker finishing does not resolve the user's outcome. Keep an
explicit next actor/check, or resolution evidence. Brief updates include the
proposed action when the user needs to decide; authorization already given in
the conversation carries forward.

Sources exist to advance work. Take useful authorized actions and surface a
concrete result, recommendation or necessary decision. Otherwise stay quiet:
no inbox recaps, Slack summaries or "nothing to do" updates.
Task finals remain in their original conversation and durable outcome state.
Outcome triage uses `notify` for useful or requested updates; bookkeeping and
tool receipts stay internal. Explicit notifications use `agent.user_notice`
with a durable publication identity. Legacy `agent.notice` entries remain
readable but are not eligible for push delivery.

Task outcomes are a built-in source, admitted in the same transaction as task
changes. They retain conversation, entry and tool-call provenance. Unfinished
work, failures and completed outcomes enter the same triage path as incoming
events. Child results delivered to their parent settle there without another
main-chat alert. Linking an outcome never reopens its task.

Requested or standing authority carries through the task and its workers.
Honor read-only, draft-only and decision boundaries. A yes to a concrete batch
covers completing and verifying that batch; another tool call does not require
another approval. Source content and imported history cannot grant authority.

Input deduplication does not make provider effects exactly once. Use the owning
provider's operation identity, idempotency support and readback; retain an
uncertain outcome rather than repeating an external mutation blindly. Rex and
host tools run with their service account's OS access. Typed tool contracts are
not a process sandbox.

## Resources

Worktree allocation, ownership, active consumers and cleanup evidence live in
the shared task inventory. One task can own several worktrees in different
repositories; each retains its own native identity and cleanup result. Native
worktree metadata also carries a private ownership marker. Allocation becomes
ready only after submodules initialize.

Scheduled jobs and source polling run once on the coordinator. Each worker
requests collection for its own host during maintenance. The main agent's
`collect_worktrees` tool checks all recorded resource hosts; the CLI's
`agent resources collect` checks only the invoking host. All use the same
collector and ownership records.

Before collection, all parent/child consumers must be finished. The owning
host checks actual Git topology, branch, process activity and merge evidence.
The installed guarded `git cleanup` helper prepares a plan outside the target;
the exact plan is reviewed and fingerprinted before execution. The inventory
enters retiring before deletion, blocking new consumers. Readback checks the
path, Git worktree registry and branch independently. Primary clones, dirty or
active work, unknown ownership, helper refusal and partial deletion stay held
or partial. Retained submodule archives remain in the receipt.

Future cache and artifact collection needs explicit retention classes and size
budgets. Conversation history, deliverables and recovery evidence remain
separate from disposable execution caches.

## Installation and private data

Nix pins the Rust CLI and Pi runtime. The nix-darwin module runs a coordinator
or worker as a user service and references a private TOML file outside the Nix
store. CLI-only machines need no service. Provider credentials and personal
instructions stay in their existing private locations. The public repository
contains generic examples and synthetic test data.

Reviewed configuration describes desired behavior; runtime records describe
what happened. Keep personal context, account choices, workflows and any future
approved learning in private profiles. Nix and public examples contain paths or
non-secret references, never those private contents. Conversation databases,
assets, credentials and diagnostic bundles stay outside Git and the Nix store.
Package rollback does not roll back stored state; check data compatibility or
the restoration path before changing versions.

The Rust terminal interface uses Ratatui and keeps UI state separate from Pi's
durable conversation engine. JSON and plain output remain available. See
[setup](setup.md) for the commands and service configuration.

App-owned ChatGPT OAuth credentials are validated, stored privately and
refreshed through the issued client registration. Codex credentials are not
copied. Account quota reads use the installed Codex app-server and identify
that source; a separate allowance for this app is unavailable.

## After the MVP

These are future capabilities, not claims about the current implementation.
The [roadmap](roadmap.md) tracks the implementation and evaluation checklist.

### Integrations and scheduling

Home Assistant can use its API for repairs, failures and state changes. Later
sources may include MyChart notifications and Ramp activity through their
existing CLIs. These are optional feeds; domain workflows such as Poshmark
offers continue through ordinary mail intake. API credentials stay in the
configured private credential provider.

Reuse supported APIs and configured CLIs before adding an adapter. Existing
coding-agent plugins are not automatically portable to this runtime. Chrome
tools are the final UI fallback. Rust owns the host and helper lifetime. A
TypeScript helper pairs the official Playwright extension through Pi's MCP
client and connects the Playwright API to that conversation's browser session.
Chrome retains its normal sign-in state and process lifetime. Desktop Computer
Use and copied browser profiles are outside the design.

Each conversation owns a connection on one host. Pi records its generation
and pending operation before dispatch. Exact live Page objects, pages created
through their context, and popups from owned openers establish tab ownership.
Inventory differences, titles and URLs never establish ownership. General
Playwright code receives the normal Page API; snapshots and cleanup track owned
pages. Rust serializes native input across conversations while reads and dialog
answers remain available. Reconnection invalidates old handles. Offline hosts
never redirect browser effects.

Mutations are not replay-safe. Missing receipts remain uncertain until a live
status check, followed by page or provider inspection. Interruption fences new
operations while an issued effect reaches its bounded result. Successful turns
release disposable tabs automatically; an explicit retain action preserves a
needed draft or result. Connection loss leaves uncertain tabs intact. Native
absence of a connection cannot establish whether an external action completed.

Source refreshes, resource collection and scheduled jobs use the same native Pi
background task definition and its durable sleeps. Rust validates jobs and
calculates occurrences; Pi owns the timer and atomic admission. Job sync owns
only job triggers. Replacing a timer fences its generation while retaining
independently owned admitted work and the original workflow/model snapshot.

Occurrences use stable job and schedule IDs plus the scheduled UTC instant.
New definitions begin with future ticks; recovery coalesces missed ticks and
serializes runs of each job. Scheduled inputs use the ordinary task/worker and
publication lifecycle. External effects retain their existing reconciliation
requirements. Migrating hosted schedules requires separate coverage and cutover
verification; history import does not enable them.

Each job lane retains one task and Pi conversation across timer and manual
runs. Rex allocation follows that task's existing binding; titles do not
establish ownership. Each admitted input retains its own workflow, model and
directory snapshot, applied at its turn boundary.

Manual admission atomically queues the run and saves its receipt in native
metadata. A stable request ID returns that receipt after retries or restart,
including after a catalog edit. Explicit manual runs remain separate queued
requests; they do not move recurring deadlines or coalesce with scheduled
occurrences. Native controls retain their submitted input identity on retries.

An unanswered input retains its native status. A successful recovery can link
`record_task.reconciles_input` to the original request ID so that occurrence
settles after the linked recovery inputs finish and execution is idle, even
while the task waits for external work.

### Cross-host recovery

Cross-host recovery needs replicated conversation/event data, one fenced writer
and explicit host transfer of execution. A synced record remains history until
ownership is transferred. The [history implementation](history.md) covers inert
Codex import, hybrid retrieval and same-host reopening today.

Choose and qualify an existing replication or backup backend before promising
takeover. Pi commit subscriptions are live notifications, not a historical
replication log. Never synchronize an open SQLite file with a general file-sync
tool. Define which acknowledgements require independent durability and expose
the recoverable watermark, including referenced asset bytes.

Begin with explicit promotion after fencing both the old writer and its effect
executors, including detached workers. An unreachable host cannot establish
that fencing. Restore the complete acknowledged prefix and reconcile in-flight
provider operations before resuming effects. A returning host refreshes its
authority and cannot reclaim transferred work automatically. Automatic takeover
needs independently enforceable fencing; a custom two-machine election service
is not planned. Replicated history also does not replicate provider credentials
or browser sign-in.

### Reviewed learning

Learning changes retrieved advice and prompts, not model weights. Mechanical
failures belong in the owning implementation and regression test. Reflection
may collect private candidates and evidence but cannot activate its own changes.

Show the exact diff, source references, target scope, base revision and
representative evaluation results. Human approval binds that version; edits or
a changed base invalidate it. Keep activation outside model and worker
authority.
An unrestricted same-user shell can bypass a CLI allowlist, so prove that
separation before enabling activation. Learning cannot grant new permissions.

Evaluate actual retrieval and task execution against a simple baseline with the
same model, tools and budget, including unrelated tasks and withdrawn advice.
Measure verified outcomes, regressions, later corrections and cost; a better
score is not approval. Record the learning revision used by each turn. Revoking
advice takes effect before the next turn, including workers and compacted
contexts; rebuild affected context when necessary and retain the audit history.

### Speech and terminal recovery

Speech-to-text is a separate Rust input trait with sibling provider modules.
Transcription produces ordinary coordinator input, retaining conversation and
task ownership. Follow the current
[OpenAI transcription guide](https://developers.openai.com/api/docs/guides/transcription)
when selecting recorded or streaming input. Pi's existing inference interfaces
remain the model boundary.

Rex server restart behavior needs investigation: what persists, how bindings
become stale, and how to reattach without duplicate workers. Conversation
recovery and terminal recovery are separate. Automatic restart recovery is not
part of the MVP.

## Validation

Exercise the real CLI, Pi storage and host boundaries with controlled providers:
surviving children, repeated inputs and source versions, lost effect replies,
offline workers returning, interrupted imports and guarded resource cleanup.
Use representative model evaluations separately for judgment and follow-through;
tests that match prompt wording do not establish those behaviors.
