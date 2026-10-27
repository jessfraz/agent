# Remaining MVP design

The current foundation is described in the README. These are the next slices,
not features that already ship.

```text
  main conversation
         |
    find related work
         |
         +-- existing task -> resume its conversation
         |
         `-- no match ------> create one task
                                  |
                           named Rex session
                           on the selected host
                                  |
                      outcome returns to the main chat
```

The main chat is the front door. Before creating work, look for an existing
task using saved source references, then conversation text, titles and
summaries. Read the strongest candidates and continue the matching task. Several
conversations can inform one task; retain those links and one owning
conversation. The user should not have to find or enter a subchat to continue it.

A task has a stable ID, a concise title, an outcome, source links and its current
execution binding. A Rex session is its execution view, not its identity. Keep
one session per task, on the host running it, and reuse it when continuing work.
Store allocation intent before creating the session. An uncertain creation
requires reconciliation instead of a blind retry. A synchronized history record
must never create another worker or sidebar entry.

Pi owns durable conversations and model execution. Rust owns application
contracts, task transitions, external CLI boundaries and resource ownership.
Persist data; reacquire and validate live capabilities. Keep the Pi adapter
narrow so upstream improvements replace our code instead of growing a second
harness.

One selected coordinator owns the MVP store. Clients and Rex workers can run on
different hosts. Do not copy a live SQLite database between devices. Replication
and fenced recovery are later work; an unavailable coordinator is an explicit
MVP limitation.

Mail intake covers every configured account, with separate cursors and coverage.
Admit a source event durably before advancing its cursor. New replies and due
checks return to existing work. A worker finishing does not establish that the
user's outcome is resolved: retain the next actor, next check or resolution
evidence, and send a brief actionable update.

History import, cross-host recovery and learning follow the MVP. Learning must
show an exact proposed diff and evaluation evidence, and require human approval
before activation. Private instructions, credentials and personal records stay
outside this repository throughout.
