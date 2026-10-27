# agent

An agent, regrettably.

A Rust CLI around [Pi Durable](https://github.com/earendil-works/pi), with
ChatGPT plan sign-in, persistent conversations and workers in
[Rex](https://www.superlogical.com/rex). One main conversation finds existing
work before starting another task.

```text
  phone CLI via Rex    laptop CLI    desktop CLI
           \              |             /
            +-------------+------------+
                          |
                   desktop coordinator
                   Pi Durable + SQLite
                   settings + context
                   mail / Slack / feeds
                          |
               find and reuse the right task
                          |
           +--------------+---------------+
           |                              |
      desktop agent                  laptop agent
      local Rex                      local Rex
      |                              |
      + Fix login                    + Update dependencies
      | + Implementation             | + Implementation
      | + Review                     | + Checks
      |                              |
      + Track shipment               + Investigate slow build
        + Follow-up                    + Investigation
                                       + Review
```

Every chat uses the coordinator. Each task gets one named Rex session on its
execution machine; its subagents get named terminals inside that session.
Results return to the main chat, so visiting task sessions is optional. Worker
connections share metadata, not duplicate executions. Offline workers retain
their tasks; automatic transfer to another machine comes later.

Rex task tabs open directly into chat and accept replies after a turn finishes.
`agent` reopens the main conversation. Both show recent saved history;
`/history` reads older pages and `/exit` detaches without deleting history.

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
```

[Setup](docs/setup.md) covers services, trust and provider CLIs. Commented TOML
examples show the [coordinator](examples/coordinator.toml) and
[worker or client](examples/client.toml) settings. Only the coordinator needs
model defaults, background sources and optional context repositories. Context
is available without changing the directory where chat started. Hosts announce
their own identity and launch paths, using Rex's host inventory when available.

The CLI loads `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md` and project
instructions. Pi supplies inference and conversation machinery. ChatGPT is the
default; other providers use Pi's environment or ambient credentials. New tasks
inherit the coordinator's typed model, reasoning and fast-mode settings;
resumed tasks retain their saved selection. `agent usage` reads the installed
Codex account's quota and cannot report a separate allowance for this app.

Sources use existing authenticated CLIs: Google mail and calendars through
Switchboard and `gws`, GitHub through Switchboard and `gh`, a configured Slack
CLI, and the read-only macOS `messages` CLI. Each can be disabled. Failed reads
remain visible as coverage gaps. Task outcomes are built in.

Tasks can own multiple worktrees. `agent resources list` shows their inventory;
`agent resources collect` uses the installed guarded `git cleanup` workflow.
Only merged, clean, inactive work is eligible. Missing helpers, uncertain
ownership and partial results stay visible. Services check local resources
every five minutes.

The [architecture](docs/architecture.md) describes ownership and later recovery,
history import, speech input and reviewed learning. Private settings,
credentials and conversations stay outside this repository.

For development:

```sh
nix develop
make runtime check
nix build
```

Rust generates TypeScript bindings and JSON schemas. CI runs behavior tests
and package builds on Linux and macOS without personal accounts.
