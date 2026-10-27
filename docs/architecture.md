# Architecture

One main conversation is the front door. Task conversations retain their own
history and report concise, actionable results back to it.

```text
  user input / incoming event / due follow-up
                       |
               find related work
              /                 \
       matching task          new task
              \                 /
               durable task record
                       |
            choose execution host
                       |
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

Rust types generate TypeScript bindings and JSON schemas. The runtime validates
both directions at the wire boundary. Stored resource records describe intent
and evidence; native handles and ownership must be checked again before effects.

```text
  laptop CLI -- same-user Tailscale -- desktop coordinator
       |                                 |
  laptop Rex                         Pi Durable store
                                         |
                                    desktop Rex
```

One selected coordinator is the only writer and source poller. Clients and
workers on either machine use that same store. A process lock is inherited by
the Pi child, so losing its Rust supervisor does not admit a second writer.
Local clients use a private Unix socket. Remote clients use Tailscale with live
peer identity checks, or an existing SSH connection.

The MVP does not replicate the store or recover onto another Mac. If the
coordinator is down, the client reports that it is unavailable. Copying a live
SQLite database or starting two coordinators is not a recovery mechanism.

## Tasks and Rex

A task has a stable ID, title, intended outcome, source links, summary, pending
inputs and one owning conversation. Its Rex binding records the actual host,
session, window and terminal. Search ranks exact provider/account/thread links
first, followed by titles, summaries and saved conversation text. Read relevant
candidates before choosing one; several conversations may inform one task.

One task maps to one top-level Rex session on its execution host. Child agents
have independent conversations and named terminals inside that same session.
They return results to their parent; the parent returns the outcome to the
main chat. The same task cannot acquire a second active execution. Recent task
activity promotes its session in the host's sidebar.

Persist allocation intent before creating a session or terminal. A missing
creation receipt becomes uncertain and requires reconciliation. History sync
must never create an execution. Continuing an exited worker reuses its session;
it creates a replacement terminal and closes only the recorded exited pane.
Rex server restart recovery remains an open question below.

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

Background sources implement a Rust trait in `sources/mod.rs`, with sibling
providers such as `google.rs` and `slack.rs`. The coordinator rediscovers
configured accounts, polls bounded pages and preserves separate cursors and
coverage. Admit events durably before advancing a cursor. Partial reads never
pretend to be complete, and repeated event versions do not create duplicate
work. Exact triage input survives interrupted requests.

Email replies and due checks enter the same routing path. A tool must durably
link each event to work or dismiss it with a reason; prose alone does not clear
the inbox. A worker finishing does not resolve the user's outcome. Keep an
explicit next actor/check, or resolution evidence. Brief updates include the
proposed action when the user needs to decide; authorization already given in
the conversation carries forward.

## Resources

Worktree allocation, ownership, active consumers and cleanup evidence live in
the shared task inventory. Native worktree metadata also carries a private
ownership marker. Allocation becomes ready only after submodules initialize.

Before collection, all parent/child consumers must be finished. The owning
host checks actual Git topology, branch, process activity and merge evidence.
The installed guarded `git cleanup` helper prepares a plan outside the target;
the exact plan is reviewed and fingerprinted before execution. The inventory
enters retiring before deletion, blocking new consumers. Readback checks the
path, Git worktree registry and branch independently. Primary clones, dirty or
active work, unknown ownership, helper refusal and partial deletion stay held
or partial. Retained submodule archives remain in the receipt.

## Installation and private data

Nix pins the Rust CLI and Pi runtime. The nix-darwin module runs one coordinator
as a user service and references a private configuration file outside the Nix
store. Provider credentials and personal instructions stay in their existing
private locations. The public repository contains generic examples and
synthetic test data.

App-owned ChatGPT OAuth credentials are validated, stored privately and
refreshed through the issued client registration. Codex credentials are not
copied. Account quota reads use the installed Codex app-server and identify
that source; a separate allowance for this app is unavailable.

## After the MVP

Cross-Mac recovery needs replicated conversation/event data, one fenced writer
and explicit host transfer of execution. A synced record remains history until
ownership is transferred. Codex history import should retain provenance and
source references without inventing prior Pi tool executions.

Learning produces a proposed instruction/code diff and representative evaluation
evidence. Human approval is required before activating that diff. Keep learning
versions reversible and measure whether accepted changes improve outcomes.

Speech-to-text is a separate Rust input trait with sibling provider modules.
Transcription produces ordinary coordinator input, retaining conversation and
task ownership. Follow the current [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/transcription)
when selecting recorded or streaming input. Pi's existing inference interfaces
remain the model boundary.

Rex server restart behavior needs investigation: what persists, how bindings
become stale, and how to reattach without duplicate workers. Conversation
recovery and terminal recovery are separate. Automatic restart recovery is not
part of the MVP.
