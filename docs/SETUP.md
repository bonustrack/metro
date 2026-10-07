# Setup

What a Claude Code session on a metro box looks like, and how it gets that way. Since
`0.1.0-beta.105` none of it is pasted or typed: the metro plugin and the daemon apply it,
and this page explains what they apply, how to check it, and what it costs.

## What is applied, and by what

| Piece | Applied by | Where it lands |
| --- | --- | --- |
| Orchestrator-only guard on the main thread | the metro plugin (`hooks/hooks.json`, `bin/guard.mjs`) | every session where the plugin is installed |
| Standing rules loaded at session start | the metro plugin (`bin/session-start.mjs`) | read from the `metro` skill |
| The `metro` skill | the daemon, at boot, from `plugin/METRO.md` | `~/.claude/skills/metro/SKILL.md`, editable on the Skills page |
| The `stage` skill | the daemon, at boot, from `plugin/STAGE.md` | `~/.claude/skills/stage/SKILL.md`, editable on the Skills page |
| The `memory` skill | the daemon, at boot, from `plugin/MEMORY.md` | `~/.claude/skills/memory/SKILL.md`, editable on the Skills page |
| The daily memory routine | the daemon, at boot, switchable on the Harness page | the agent's crontab, shown as `memory-routine` on the Scheduled page |
| The `worker` subagent | the daemon, at boot | `~/.claude/agents/worker.md` |
| Privacy settings and transcript retention | the daemon, at boot, switchable on the Harness page | `~/.claude/settings.json` |
| The metro MCP server, Channels, the model route | `metro claude`, at every launch | the session only |
| The session itself | the daemon, in a tmux session named `metro` | the Terminal tab |

The daemon installs the plugin on the machine it runs on and updates it with `metro update`,
so all of this moves with metro. A box needs nothing but `metro service install`, and a box
launched from metro.box needs nothing at all.

## Orchestrator-only main thread

An agent connected to metro is holding real conversations while it works, and inbound
messages are only noticed between tool calls. A main thread that greps, builds and reads
files is busy, and a busy one does not see a message for minutes. The guard enforces the
split in the harness: the main thread receives, acknowledges, delegates and relays;
subagents do the work.

The guard is a `PreToolUse` hook in the plugin, written in Node so it has no `jq` to fail
open on. On the main thread it allows:

| Tool | Why it stays |
| --- | --- |
| `Agent`, `Workflow` | Delegation. The whole point, and the only way back if you break something. |
| `mcp__*` | Talking to the outside world: the metro tools and every connector the agent holds. |
| `ToolSearch` | Loads schemas for deferred tools. Without it the metro tools cannot be called at all. |
| `Skill`, `ScheduleWakeup`, `Monitor`, `Cron*`, `Task*` | Scheduling and tracking. They coordinate work rather than perform it. |
| `Read`, raster images only | So a screenshot someone sends can be looked at directly. `.svg` and `.pdf` are text underneath, so they stay denied. |

Everything else on the main thread is denied with a reason that says to delegate: `Bash`,
`Write`, `Edit`, `Grep`, `Glob`, `WebFetch`, `Read` of any text file. `Agent` with an explicit
`run_in_background: false` is denied too, because a foreground subagent blinds the main
thread to chat until it returns.

Denied everywhere, main thread and subagents alike: `AskUserQuestion`, `ExitPlanMode`,
`EnterPlanMode`. Nobody watches the terminal around the clock, so a blocking prompt is an
indefinite stall. The rules tell the agent to ask over chat instead and keep working.

Subagents are recognised by the `agent_id` their hook payloads carry; main-thread payloads
omit it. A payload that does not parse is denied, never allowed.

**The guard is on wherever the plugin is installed**, with no switch. A daemon on a personal
machine installs the plugin there too, and its Claude Code sessions get the guard; that is the
trade-off chosen for boxes never sitting half configured.

### The worker

`worker` is not a built-in subagent type; the daemon writes it to `~/.claude/agents/worker.md`
at boot when it is missing. It has full tool access and maximum effort, works to completion,
never calls a blocking tool, and reports to the orchestrator with evidence. When a new metro
release changes the text, the daemon replaces a copy that metro wrote and nobody edited. A
copy edited on the box is never touched, so edits stick.

### The standing rules

`~/.claude/skills/metro/SKILL.md` holds the rules: read `addressed` before
answering, react first, delegate everything that is work, never wait on the terminal, report
like a relay, keep going. The daemon writes it from the copy the plugin carries, and the
plugin's `SessionStart` hook loads its body into every session, so the agent does not have to
invoke the skill. Edit it on the Skills page to change the rules on that box; an edited copy is
never replaced by an update. The plugin's copy is only the fallback when the file is gone.
Until 2026-10-01 the skill was called `metro-orchestrator`; the daemon moves that folder to
`metro` at boot and keeps any edits.

### The Stage skill

`~/.claude/skills/stage/SKILL.md` tells the agent how to use Stage channels (XMTP groups) with
the metro tools: create a channel, rename it, add or remove members, set labels and
assignees, and send, reply, react, delete and read messages. It is written on every box, but it
only works when the agent has an XMTP account, and it says so. It is not loaded at session
start: Claude Code offers it like any other skill. Edits stick the same way.

### The memory skill and the daily memory routine

`~/.claude/skills/memory/SKILL.md` describes how the agent keeps its long-term memory, in the
layout of Instinct (https://supermemory.ai/blog/reverse-engineering-instinct-memory/):
`entities/people`, `entities/orgs`, `knowledge/facts`, `knowledge/preferences`,
`knowledge/decisions`, `comms/phone`, `timeline/daily`, `timeline/weekly`, `workstreams/active`
and `workstreams/completed`, under Claude Code's own memory folder
(`~/.claude/projects/-home-agent/memory/` on a box), with `MEMORY.md` as the index. It also sets
the note format (frontmatter, one subject per file, dated bullets, `[[links]]`), the rules (no
secrets, nothing from WhatsApp or Telegram feeds, never delete or rewrite a note, the owner's own
rules win, an index under 200 lines) and the routine. Edits stick the same way.

Twice a day, at 00:00 and 12:00, the agent's crontab runs `~/.metro/bin/memory-routine
~/.claude/skills/memory/SKILL.md`, a launcher the daemon writes, which runs `metro memory` with
that skill file (the shipped `MEMORY.md`). The job is always named `memory-routine`, and the
Scheduled page shows the skill as its script. That command checks the Claude Code transcripts. When none changed since its
last successful run, it stops and uses no tokens. Otherwise it creates the ten folders when
they are missing and runs Claude Code once, headless (`claude -p`), on the box's model route,
with the box's system prompt. Claude Code reads the skill and files the day into memory, then
writes or adds to the daily note and, when it is missing, last week's weekly note. That run has no metro
MCP server and no plugin, so it never takes the chat session's place. It saves no transcript.
Its tools are Read, Glob and Grep, plus Write and Edit inside the memory folder only
(`--permission-mode dontAsk`): no shell, no network, no subagents. After a good run, the routine
moves the workstream notes marked `completed`, `parked` or `abandoned` to
`workstreams/completed/` and fixes their lines in `MEMORY.md`. It reads at most the last two
days. A lock keeps one run at a time, and a run is stopped after 50 minutes. Its output goes
to `~/.metro/memory-routine.log`, which the Scheduled page shows, with Run now. The time is the
box's own clock, which is UTC on a box Metro launched.

The switch is **Daily memory** on the Harness page (`memoryRoutine` in `claude-setup.json`, on
unless switched off). Off removes the cron line. A box keeps one memory job: an agent cron job
with `memory` in its name, like an older `memory-upkeep`, is replaced by `memory-routine` and
stays in the crontab as a `# replaced by memory-routine: ` comment, which Off turns back into
the job. A cron line with `memory` only further in its command (run through a shell, a lock or
`claude -p`) and a timer with `memory` in its name or command are kept instead, and the default
job is not added, so memory is never kept twice. The Harness page names that job.

### Local scheduled work in the Agent SDK session

`metro task submit <routine> <prompt-file>` durably submits a stored task for the current
UTC hour. Use `--slot <UTC ISO timestamp>` for another schedule's exact firing time. A
routine ID is a lowercase letter followed by at most 63 lowercase letters, digits or
hyphens. The same routine and slot with the same prompt return the same receipt; a different
prompt at that key is refused. Exit zero means accepted on disk, not delivered or completed.
`--dry-run` checks the submission without creating a queue, receipt, session or timer.

Run the command from the agent's existing user cron or timer, with the normal CLI and Bun
on its PATH. For example, after storing an owner-approved prompt at `/home/agent/bin/check.md`:

```cron
0 * * * * /home/agent/bin/check-routine /home/agent/bin/check.md >> /home/agent/logs/check-routine.log 2>&1
```

The launcher runs `metro task submit check-routine "$1"`. On a managed Linux box whose
PATH does not contain `metro`, use `node /var/lib/metro/.npm-global/lib/node_modules/@stage-labs/metro/dist/cli.js task submit check-routine "$1"` instead, as the existing memory launcher uses the installed CLI's absolute path.
This is an example, not an installed default. The Scheduled page discovers the existing
cron line, prompt and log as before. This changes neither the separate memory routine nor
any existing job's cadence.
Cron submits while the SDK is offline but does not start it, bypass a Harness Stop, take its
MCP slot, change its model or permissions, or wake a machine that is powered off. Missed
whole-machine ticks are not backfilled; the first later firing is the next check. Queued
slots of one routine coalesce to the newest before admission, rather than replaying every
missed hour. The Claude Code runner does not consume this separate queue: switching to it
parks accepted tasks until the Agent SDK runner is selected and started again.

The existing SDK runner polls every five seconds and uses its ordinary bounded input
admission. Inputs have the pinned SDK's `task-notification` / `scheduled-trigger` origin,
never a fabricated person or channel. Local account ownership authenticates the producer;
it does not attest human authorship or approve the prompt. The worker must verify the
original owner request and later pauses, retain the original task owner, avoid duplicate
work and uncertain side effects, and obey the existing tool policy.

`metro task status [routine]` reads receipts without exposing prompts or creating files.
The queue lives beside `agent-session.json`, under `automation` (also when
`METRO_RUNNER_STATE` selects an isolated state path). It uses a private, bounded native
SQLite store, not a journal of channel messages. Prompts are at most 64 KiB in UTF-8 and
128 KiB plus two quote bytes when JSON encoded, leaving room for the host envelope within
normal input admission. At most 512 requests are retained, and submissions older than
seven days or more than five minutes ahead are refused. Settled records stay at least seven days; unresolved work is never evicted to make
room. A full, corrupt or insecure store fails visibly rather than silently dropping work.

A durable dispatch fence is saved before yielding an input to the SDK. Only work never
dispatched can be replayed automatically after restart. A crash after that fence, even just
before actual delivery, is uncertain and requires verification. The existing bounded task
recovery notices handle that obligation; the action prompt is not replayed. This does not
promise exactly-once external effects.

A successful main turn is only `awaiting-completion`: its background worker can still be
running. After the sweep finishes checking tasks and recording any dispatched workers'
claims, its worker records `metro task finish <delivery-uuid> <completion-token> completed`.
The SDK envelope supplies both values and an absolute command using the shipped entry,
so the worker can finish even when `metro` is not on its PATH. This finishes the sweep,
not every issue worker it resumed. A genuine sweep blocker uses `blocked` instead and holds later runs of the same
routine. After verifying the original worker, side effects and changed condition, a worker
can explicitly resolve the same token with `completed`; it must not use that receipt as
permission to replay an action. Completion is monotonic. Other routines and unrelated
workers do not inherit that block. Explicit Harness Stop cancels active runs and keeps the
session stopped; it does not clear an existing failed or interrupted hold. Queued files
never restart it.

## Privacy and data retention

On by default, switchable on the Harness page. The daemon merges into `~/.claude/settings.json`:

```json
{
  "env": {
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": "1"
  },
  "cleanupPeriodDays": 7
}
```

Other keys in the file are kept, an existing `cleanupPeriodDays` is kept, and a file that does
not parse is left alone. Turning privacy off removes exactly those four variables.

What stops leaving the machine: usage metrics, error reports and stack traces, session-quality
surveys, feature-flag fetches, and update checks. What does **not** stop: prompts, file
contents, command output, tool results and model responses still go to the model. That is the
product working, not telemetry, and no setting here changes it.

**Why the fourth variable, and the cached flag.** Turning telemetry off also turns off
feature-flag evaluation, and the flag that enables Claude Channels defaults to off, so without
more the agent would stop receiving chat. The fourth variable makes Claude Code read its local
cache of flags instead, and `metro claude` seeds the Channels flag into that cache at every
launch, whether or not the box has a claude.ai login. Measured on Claude Code 2.1.261: with the
four variables and the seeded cache, Channels come up, with and without the daemon's gateway
address; without the fourth variable they do not. The cache never refreshes on its own, which
is stable rather than correct, and the variable is undocumented: re-check after a Claude Code
update by sending the agent a message.

**Local disk.** Claude Code writes every transcript to `~/.claude/projects/` in plaintext,
tool results included. `cleanupPeriodDays` sweeps them after a week; `history.jsonl`, every
prompt ever typed, is not swept by anything. Keep the volume encrypted and never sync the
directory anywhere. `claude project purge <path>` removes one project's traces.

## Live messages

On by default, switchable on the Harness page (`liveEvents` in `claude-setup.json`). Off, the
daemon stops pushing chat messages into the session at once, with no restart: nothing arrives
on its own, and messages that come in meanwhile are not delivered later. The agent keeps every
tool (send, react, read and the rest), and a permission prompt is answered on metro.box only,
since no answer from a chat can reach it.

## Check it

- **Harness page**: the Setup block lists the guard, the worker, the rules and the privacy
  settings, each green when in place.
- **Terminal tab**: the session the daemon started shows the metro channel loaded and no
  wizard. Ask the agent to run `echo hi` with Bash: it must say the main thread is
  orchestrator-only and delegate instead.
- **From chat**: send the agent a message. It should react, then answer.

## What it costs

The main thread cannot read a file, run a command, edit anything or fetch a page, ever,
including to fix this setup. Every piece of work is a delegation, every fact in a reply is a
worker's claim rather than something the orchestrator saw, and a task that would have been one
`grep` is now a round trip. What it buys is a thread that is never too busy to answer, which
for an agent whose job is to be in conversations is the better half of the deal.
