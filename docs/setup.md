# Setup

Install [Rex](https://www.superlogical.com/rex) and Tailscale on each execution
machine. Connect them to the same authorized tailnet. Provider CLIs keep their
own accounts and credentials; agent does not duplicate that setup.

## Coordinator

Choose one machine that stays on. It owns conversations, shared settings,
background intake and the main agent.

```sh
nix profile add github:jessfraz/agent
agent init
agent serve
```

`agent init` creates `~/.config/agent/config.toml` with private permissions and
refuses to overwrite an existing file.

`agent serve` listens on the native Tailscale interface at port 43187 and a
private local Unix socket. Leave it running, then use another terminal:

```sh
agent login
agent status
agent chat
```

Start the service before login. Otherwise the CLI starts a local-only daemon,
which owns the same database and prevents a second coordinator from starting.
A Nix service also satisfies this ordering. `agent login` opens ChatGPT
sign-in; complete any identity check in the browser. Credentials are stored
privately and refreshed by the app. No Codex credential copying is required.

ChatGPT is the default provider. A signed-out chat reports `Not signed in to
ChatGPT. Run agent login.` Other Pi providers can use their supported
environment or ambient credentials. Agent does not provide an interactive
login flow for every provider.

## Worker or CLI client

On another execution machine:

```sh
nix profile add github:jessfraz/agent
agent init --coordinator tailscale://100.64.0.10
agent serve
```

Replace the invented address with the coordinator's native Tailscale IPv4
address. The port is optional. The worker announces its native Rex identity
and local launch paths, and keeps a reverse connection to the coordinator.
Rex host labels and endpoints are reused when present in its shared host
inventory; a machine can also announce its own native Rex metadata. There is
no second host list to maintain in agent settings.

Use `agent chat` from any directory in another terminal. It always reaches the
configured coordinator. Caller project information accompanies the request;
shared context and conversation storage stay on the coordinator. `agent nodes`
shows registered machines and which are online.

In the TUI, `agent` opens that same saved main conversation and attaches to
ongoing work. `/exit` or Ctrl+C detaches main chat while the work continues.
Reopen it to see live progress, steer or queue more context. Saved messages load
automatically in the background while the composer remains usable.

Task sessions open directly into an interactive `Chat` tab. Reply there or
through the main agent; both use the same task conversation. Named child tabs
return results while remaining available for follow-ups. Live activity shows
tool names and exposed provider thinking text.

TTY sessions use a Markdown TUI with model, reasoning, directory and activity
status. Enter steers active work; Tab queues a separate follow-up turn. Queued
messages run in FIFO order. Esc stops, and Shift+Enter or Alt+Enter inserts a
newline. Press `?` in an empty editor or use `/help` for commands and shortcuts,
generated from the same definitions used to parse them.
Input sent after Esc waits for that conversation's stop receipt; editing and
other chats stay responsive. If stopping cannot be confirmed, the input stays
unsent for recovery.
Pi's compaction shows as **Compacting context**; current instructions reload
before the next model round.
Select transcript text with the terminal's normal copy/paste controls;
the wheel and trackpad use native terminal scrollback. PgUp/PgDn scroll the
loaded conversation or shortcut help. On a Mac, use Fn+Up/Fn+Down.
Up/Down recalls sent prompts when the
editor is empty; slash commands offer completion. Use `agent --no-tui chat`
for plain output or `agent --json chat` for protocol events.

Reopen the CLI after updating it to load presentation changes. Detaching an
older client preserves server-owned work and saved history.

`/resume` opens a saved-chat picker in this terminal. Filter by title or ID,
press Enter to choose, or Esc to keep the current chat and draft. Browsing
history does not start work. A new message reuses the selected conversation's
worker, reopening its Rex session in the background when needed.

Use `/model`, `/reasoning` or `/fast` to change the current conversation, and
`/status` to inspect its effective settings, connection and available plan usage.
`/model` without an argument lists models; `/fast` alone toggles fast mode.
Changes persist when the conversation reopens and apply to the next model
generation. TOML supplies defaults for new work. `/help` has the accepted
arguments; Pi validates model capabilities.

OpenAI Responses models have hosted web search enabled, including page opening
and find-in-page when the model supports them. The same tools apply to the main
agent, tasks and child agents. Citations remain copyable links in saved history.
Availability depends on the model and account; an unsupported tool is reported
as a capability failure. Other providers keep their native tool configuration.
This does not give the agent access to a signed-in Chrome session.

### Chrome

Chrome tools are an optional fallback when an API or CLI cannot complete the
task. They use the selected host's running Chrome, on macOS or Linux. Browser
effects stay on that host even when the coordinator runs elsewhere.

On each host that should provide Chrome, add this section to its private Agent
configuration:

```toml
[browser]
# Existing profile directory name. Default is "Default".
# profile_dir_name = "Profile 1"
# Optional credential launcher prefix; secrets enter only the browser helper.
# credential_command = ["with-credentials", "browser", "--"]
# Optional: an existing Chrome instance's user-data root, not a copied profile.
# user_data_dir = "/example/chrome-data"
```

Install the official [Playwright extension](https://chromewebstore.google.com/detail/playwright/mmlmfjhmonkocbjadbfplnigmagldckm)
in that existing Chrome profile. Its status page displays a profile-specific
`PLAYWRIGHT_MCP_EXTENSION_TOKEN`. Provide that token to Agent's service through
its private credential environment, directly or through `credential_command`,
then restart the service. Keep the token in a secret manager and out of Agent
configuration, launcher arguments, repository files, and the Nix store.
Installation and pairing are one-time setup; fresh tasks and service or
browser restarts reuse the token without another connection approval click.
Upstream opens a temporary Chrome connector URL containing the token. Agent
discards its output and closes that connector after pairing.

Agent connects to installed Chrome and the selected existing profile. Chrome
for Testing is a disposable test fixture, never a production fallback. Native
remote debugging and an exposed debugging port are unnecessary. The connector
can start installed Chrome with that same profile when it is closed.

`profile_dir_name` selects the final directory component shown by Chrome's
profile path, such as `Default` or `Profile 1`. `user_data_dir` selects the
existing browser's data root, not the profile directory inside it. The token
must belong to that exact profile. Confirm the website's account before an
account-specific action. Browser state remains local; the adapter's action
allowlist is not a process sandbox.

Ask Agent to use Chrome on a named machine when necessary. `browser_open`
creates an owned tab. `browser_status` inspects the live connection;
`browser_action` navigates, reads accessibility snapshots, fills forms, selects
options by displayed text, clicks, presses keys and handles dialogs. Handles
refer to exact live Page objects; tab reordering cannot retarget an action.
Only owned tabs and popups from those pages reach the model. Other pages
dragged into the task's group remain unowned. Moving an owned page out drops
its handle and preserves the page.

Clicks, form input, and key presses bring their owned tab to the front. Reading
snapshots leaves the foreground tab alone.

Disposable tabs close when the turn finishes. `retain_tab` preserves a needed
draft or result for the user; `browser_release` closes remaining owned tabs and
disconnects while Chrome keeps running. Retained results survive disconnect
and leave the task's tab group.

After interruption or connection loss, Agent retains uncertain operations and
inspects their outcome before repeating them. A browser or host restart
invalidates old tab handles; it does not prove a submission failed. Reconnect
to continue, preserving tabs whose ownership cannot be verified.

The first version uses accessibility snapshots. Canvas-only interfaces,
screenshots sent to the model, uploads and downloads need additional support.
Chrome settings, desktop applications and general desktop control are outside
these tools. No arbitrary JavaScript tool is exposed to the model.

See the upstream [extension setup](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)
for installation, profile selection and token pairing.

`/feedback <description>` saves private diagnostics and starts a background
repair worker on the originating machine. A repair started inside Rex uses a
named terminal in that folder; later reports reuse the repair task. From a raw
CLI, the first report creates its repair session. Results appear in the saved
main chat. `agent feedback latest` and `agent feedback show <id>` read captures;
they are never uploaded automatically.

Import existing local Codex conversations after both services are connected:

```sh
agent import codex
agent import status
agent history search "supplier fabrication question"
agent history read CONVERSATION_ID
agent history open CONVERSATION_ID
```

The import creates no Rex sessions. Rerun the same command to resume partial
reads and catch up changed conversations. `--host NAME` limits an import to a
registered host. An unavailable source is reported as partial coverage, not
silently skipped. [History](history.md) describes storage and retrieval.

A CLI-only client uses the same `agent init --coordinator ...` command and
skips the service. Phone access is the Rex phone CLI connected to one of these
machines, running the same `agent chat` command.

If the coordinator is unavailable, chat reports the failure. If a worker goes
offline, its tasks remain assigned to it. The MVP does not transfer live work
or synchronize the database between machines.

## Trust

Both ends verify native Tailscale peer identity. The listener never binds to a
LAN or wildcard address. By default, authorized untagged devices belonging to
the same user are accepted. Set `trusted_user_ids` to pinned numeric Tailscale
user IDs to accept that human's authorized, untagged devices automatically,
including a new phone, without adding each device's stable node ID. The daemon
must verify that the node's user matches its identity profile; names and email
addresses never grant trust. Set `trusted_nodes` to exact stable node IDs for
tagged servers. When either list is nonempty, a peer must match a pinned node
or a pinned user under the untagged-device rule; the default same-user rule no
longer applies. For a tagged coordinator, pin its stable node ID on clients and
pin the human user IDs allowed to connect in the coordinator's private config.

When a machine has both GUI and system Tailscale daemons, set
`tailscale_socket` to the intended daemon's socket. Identity checks and
connections use that selection. Rex's embedded Tailscale identity is distinct
from the native daemon identity used by agent.

## Settings and sources

### Scheduled jobs

Keep jobs in Git and configure `job_directories = ["~/automation/scheduled_jobs"]`
on the coordinator. A job file contains a readable stable `id`, `prompt`,
`model`, `reasoning_effort`, IANA `timezone`, and one or more `[[schedules]]`,
each with its own stable `id` and anchored DTSTART/RRULE `recurrence`. See the
[example job](../examples/scheduled_jobs/daily-review.toml). IDs are unique
across jobs and within each job's schedules; renames retain their IDs. Optional
schedule `focus` and `prompt` narrow a pass while retaining the main rules.

Run check and sync in the coordinator's checkout after editing or pulling the
files. Sync rejects remote clients so their local paths cannot select a
different working directory on the coordinator:

```sh
agent jobs check --next 5
agent jobs sync
agent jobs list
agent jobs get daily-review
agent jobs run daily-review
agent jobs run daily-review --schedule morning
```

`check` and `sync` also accept repeated `--directory PATH` arguments. Check
validates the whole catalog and previews occurrences without applying changes.
Sync replaces the managed job catalog with that complete validated snapshot:
unchanged timers retain their deadlines, changed timers are replaced, and
removed schedules stop admitting work. Missing directories, invalid TOML or
duplicate IDs leave the applied catalog intact. An existing empty directory
can intentionally remove all jobs. Source timers are outside job sync's scope.
`/jobs` and `/jobs ID` use the same read requests and presentation as list/get.

`run` queues the applied job now with its saved prompt and model. A job with
one schedule selects it automatically; a job with several requires
`--schedule ID`. `/run-job JOB [--schedule ID]` uses the same admission path.
The response identifies the durable task; admission does not mean completion.
Manual runs serialize with the job's scheduled runs without changing its next
occurrence or any source timer. Each explicit request creates a run, including
when that job already has work queued. Inspect it with `agent tasks read ID`.

Startup applies valid configured directories; validation errors retain the
applied catalog and are reported in the coordinator log. Without configured
directories it retains the last explicitly synced catalog. Jobs start with
future occurrences;
restarts coalesce missed ticks and serialize overlapping runs per job. Each
admission retains its original prompt/model snapshot. Pi wakes the running
coordinator; offline time is reconciled when it returns. Existing hosted
automations require a separate verified cutover.

The MVP accepts HOURLY, DAILY and WEEKLY rules with INTERVAL, BYDAY, BYHOUR,
BYMINUTE, BYSECOND and WKST. DTSTART must agree with the named timezone and
rule. Nonexistent local occurrences are skipped; repeated local times use the
first instant. Source polling uses elapsed intervals through the same Pi timer.

### Coordinator settings

The commented [coordinator example](../examples/coordinator.toml) is parsed by
the same strict configuration loader as the CLI and exercised in tests. The
[client example](../examples/client.toml) is sufficient for workers and
terminals. Configuration is TOML, not JSON.

Set `context_repositories = ["~/context"]` on the coordinator to make an
existing private Git repository available to every chat. Agent loads its
`AGENTS.md` and offers bounded read/search tools for relevant files. It does
not change the caller's working directory or require clients to copy the repo.

`[model]` controls defaults for new work. `provider` and `reasoning` are typed;
Pi validates the model ID. Omit reasoning to use the provider's default.
`fast = true` requests OpenAI priority service where supported; unsupported
choices fail explicitly. See the official
[fast-mode guide](https://developers.openai.com/api/docs/guides/fast-mode).
Existing tasks keep their saved selection.

Sources are optional `[[sources]]` entries. Set `enabled = false` to skip a feed
without even discovering its accounts. An empty list disables external intake;
internal task outcomes remain available.

| Source | Existing authenticated tools |
| --- | --- |
| `google` | Switchboard Google namespaces and `gws` |
| `google_calendar` | Switchboard Google namespaces and `gws` |
| `github` | Switchboard GitHub namespaces and `gh` |
| `slack` | Configured read-only CLI command |
| `messages` | Switchboard Messages namespaces, or local macOS `messages` |

Omitting `namespaces` discovers all configured accounts for that provider.
An explicit selection never falls back to another account. Slack additionally
needs its account and command prefix. The source command must be available in
the service's PATH. `agent sources` reports coverage and checkpoints; an access
failure is not an empty inbox.

Messages reads run headlessly through the local Rex Server, using its macOS
Full Disk Access grant. Enable access for Rex Server once in System Settings;
agent binaries do not need their own grant. No sessions or terminals are created
for polling. The agent's literal `messages doctor`, `messages chats`, and
`messages read` commands, including their Switchboard equivalents, use the
same reader. Their working directory, deadline, diagnostics and output limits
are preserved. Commands run directly in an unrelated shell still use that
shell's macOS permission context.

With Messages enabled, the coordinator installs the small Rex action module at
startup, and workers check it when connecting using the coordinator's settings.
Existing Rex configuration is preserved; an unchanged module causes no reload.
Setup can also be run explicitly:

```sh
agent rex install
```

If Rex configuration is managed elsewhere, include `require('agent_messages')`
through that owner. The command reports any setup failure and preserves the
existing configuration; other sources and chat can continue.

`agent usage` and `/status` read quota through the coordinator's installed Codex
app-server, after verifying its signed-in account matches the agent's. This
does not expose a separate quota for agent, and requires Codex independently.
Reset dates use the client's local timezone and include the time remaining.

`/machines` reads the coordinator's host registry and refreshes supported online
workers. It shows OS, CPU count, RAM, Tailscale IP and load averages. Unavailable
probes retain their last sample with its age; unknown measurements stay unknown.

Worker lifecycle notices include UTC timestamps. Each service also writes
rotating structured lifecycle receipts to
`<state_dir>/diagnostics/runtime.jsonl` and its numbered archives (1 MiB per
segment). Retention targets 48 hours, with a 128 MiB total disk cap including
coverage metadata and its atomic replacement. Whole expired segments leave
first; capacity pressure can remove younger segments. These record
input placement, activity, host-call timing and interruption without message
bodies, reasoning, tool arguments or credentials. The files are private to the
user; logging failure does not block chat.

A slow runtime write records one `write_backpressure` event with its request,
command kind and byte counts. Event reads continue while that write is pending.
A clean stop records `service_shutdown` with `SIGINT` or `SIGTERM` and its
timestamp before pending requests close, distinguishing a managed restart from
a runtime failure.

`diagnostics/retention.json` records the policy, expiry watermark and cumulative
timestamp bounds of capacity evictions, including uncertain timestamp coverage.
It also flags unknown history when upgrading legacy rotations. Read actual
receipt files to establish the available interval; the watermark is coverage
evidence, not an inventory of retained files. An interrupted prune can report a
conservative possible gap. `dropped_before` counts channel overflow only, so
zero does not establish complete log coverage. No finite cap guarantees a full
audit interval at an unbounded event rate.

## nix-darwin service

The flake exports `darwinModules.default`. Import it and reference a private
configuration file that already exists outside the Nix store:

```nix
{
  imports = [ inputs.agent.darwinModules.default ];
  services.agent = {
    enable = true;
    role = "coordinator"; # Use "worker" on the other machines.
    configFile = "/Users/example/.config/agent/config.toml";
    workingDirectory = "/Users/example";
    extraPackages = [ pkgs.gh pkgs.tailscale ];
  };
}
```

Include Rex, Switchboard and enabled provider CLIs in `extraPackages` as well.
The worker's TOML must set `coordinator`; the coordinator's must omit it.
Model settings, source configuration, credentials and context stay in private
runtime files. Restart the service after changing its settings.

For generated preferences, `agent config apply preferences.toml` updates only
the supplied model, context repositories, sources or polling interval in the
existing private configuration. Connection and trust settings remain local.
Invalid preferences leave the file untouched; repeated applications are a
no-op. This allows Nix to manage shared preferences without publishing machine
connection details or credentials.
