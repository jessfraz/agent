# agent

An agent, regrettably.

A Rust CLI around [Pi Durable](https://github.com/earendil-works/pi), with
ChatGPT plan sign-in, persistent conversations and workers in
[Rex](https://www.superlogical.com/rex). One main conversation finds existing
work before starting another task.

## Why

Find the old conversation. Continue the existing task. Close the loop.
Incoming email, Slack, GitHub and Messages should produce useful action or a
concrete decision. Otherwise, stay quiet.

Authorization carries forward; an approved action should not trigger another
approval loop. Pi owns the provider interface and durable conversations. Rex
owns the hosts, sessions and terminals. Reuse them.

```text
  phone CLI in Rex       CLI / Rex terminal on any host
             \                       /
              +----- agent chat ----+
                          |
               coordinator (macOS or Linux)
               main conversation / Pi Durable / SQLite
               settings / context / incoming events
                          |
               find and reuse the right task
                          |
          +---------------+----------------+
          |               |                |
   desktop (macOS)  laptop (macOS)    server (Linux)
   Rex sessions     Rex sessions     Rex sessions
   + Fix login      + Update deps    + Fix CI
   | + Chat         | + Chat         | + Chat
   | + Review       | + Checks       | + Review
   + Track order    + Investigate    + Tune build
     + Chat           + Chat           + Chat
     + Follow-up      + Review         + Profile
```

Every chat uses the coordinator. Each task gets one named Rex session on its
execution machine; its subagents get named terminals inside that session.
Scheduled jobs reuse their job's chat and Pi conversation across runs. Each run
keeps its own admission identity and captured file settings. Closing a Rex
session allows it to be reopened without losing the conversation.
The coordinator and workers can run macOS or Linux; these hosts are one example.
Results return to the main chat, so visiting task sessions is optional. Worker
connections share metadata, not duplicate executions. Offline workers retain
their tasks; automatic transfer to another machine comes later.

Rex task tabs open directly into chat and accept replies after a turn finishes.
The TUI reopens the saved main conversation with `agent` and reconnects to
ongoing work. `/exit` or Ctrl+C detaches main chat while that work continues;
reopen it to follow or steer the same execution. Saved history loads in the
background. Scroll to read it; `/resume` selects another saved chat in place.

The terminal UI renders Markdown, including tables, and shows the model,
reasoning, directory and live activity. Enter steers, Tab queues a separate FIFO
turn, Shift+Enter inserts a newline, and Esc stops. Press `?` in an empty editor
or use `/help` for commands and shortcuts. `/model`, `/reasoning` and `/fast` control this
conversation; `/status` shows its settings, connection and available plan usage.
Reset times use the client's local timezone and include a countdown.
`/machines` shows connected hosts, hardware capacity and recent load samples.
Use `--no-tui` for plain output.

The [iPhone app](ios/README.md) opens the same main conversation. Private
TestFlight updates are built from `main` after required native checks.
Attach files or photos on iOS, or drag file paths into the terminal composer.

`/feedback <description>` starts a background repair on the same machine with
private diagnostics and any attached files. It includes the current app view
on iOS or the originating terminal's HTML capture in Rex. Its result returns
to the main chat.

For example, JLCPCB emails about a missing fabrication file. The agent finds
the existing hardware task, attaches the email and continues its Rex session.
The main chat gets a brief result or the decision needed to move it forward.

On the coordinator:

```sh
nix profile add github:jessfraz/agent
agent init
agent serve
```

On another machine, with its own Rex and Tailscale already installed:

```sh
nix profile add github:jessfraz/agent
agent init --coordinator tailscale://100.64.0.10
agent serve
```

That address is invented. Port 43187 is the default. Leave each service running
or use the Nix service below. Then, in another terminal, sign in once on the
coordinator with `agent login`. A CLI-only machine uses the same settings and
skips `agent serve`. On any connected machine:

```sh
agent chat
agent nodes
agent tasks list
agent sources
agent usage
agent import codex
agent history search "fabrication files"
```

[Setup](docs/setup.md) covers services, trust and provider CLIs. Commented TOML
examples show the [coordinator](examples/coordinator.toml) and
[worker or client](examples/client.toml) settings. Only the coordinator needs
model defaults, background sources and optional context repositories. Context
is available without changing the directory where chat started. Hosts announce
their own identity and launch paths, using Rex's host inventory when available.

The agent refreshes `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md`, shared context
and project instructions before each model round, including after compaction.
Pi supplies inference and conversation machinery. ChatGPT is the
default; other providers use Pi's environment or ambient credentials. New tasks
inherit the coordinator's typed model, reasoning and fast-mode settings;
resumed tasks retain their saved selection. `agent usage` reads the installed
Codex account's quota and cannot report a separate allowance for this app.

Supported OpenAI Responses models get hosted web search, page opening and
find-in-page tools. Source links stay in saved replies. Other providers need
their own search integration. Chrome control is an optional last fallback
after APIs and CLIs. General Playwright scripts use the chosen host's existing
signed-in Chrome. [Chrome setup](docs/setup.md#chrome) covers extension pairing,
profile selection and known limitations.

Sources use existing authenticated CLIs: Google mail and calendars through
Switchboard and `gws`, GitHub through Switchboard and `gh`, a configured Slack
CLI, and the read-only macOS `messages` CLI. Each can be disabled. Failed reads
remain visible as coverage gaps. Task outcomes are built in.

Tasks can own multiple worktrees. `agent resources list` shows their inventory;
`agent resources collect` uses the installed guarded `git cleanup` workflow.
`/worktrees` shows the same inventory in terminal and native chat clients.
Only merged, clean, inactive work is eligible. Missing helpers, uncertain
ownership and partial results stay visible. Services check local resources
every five minutes.

Codex imports are incremental. Saved conversations remain searchable after
closing Rex; reopening relevant work reuses the same conversation. Local
keyword and semantic search use a rebuildable SQLite index. See
[history](docs/history.md) for import, coverage and reopening commands.

The [architecture](docs/architecture.md) describes ownership, later recovery,
speech input and reviewed learning. The [roadmap](docs/roadmap.md) tracks
remaining work and evaluations. Private settings,
credentials and conversations stay outside this repository.

For development:

```sh
nix develop
make runtime check
nix build
```

Rust generates TypeScript bindings and JSON schemas. CI runs behavior tests
and package builds on Linux and macOS without personal accounts.
