# Setup

What a Claude Code session on a metro box looks like, and how it gets that way. Since
`0.1.0-beta.105` none of it is pasted or typed: the metro plugin and the daemon apply it,
and this page explains what they apply, how to check it, and what it costs.

## What is applied, and by what

| Piece | Applied by | Where it lands |
| --- | --- | --- |
| Orchestrator-only guard on the main thread | the metro plugin (`hooks/hooks.json`, `bin/guard.mjs`) | every session where the plugin is installed |
| Standing rules loaded at session start | the metro plugin (`bin/session-start.mjs`) | read from the `metro-orchestrator` skill |
| The `metro-orchestrator` skill | the daemon, once, at boot | `~/.claude/skills/metro-orchestrator/SKILL.md`, editable on the Skills page |
| The `worker` subagent | the daemon, once, at boot | `~/.claude/agents/worker.md` |
| Privacy settings and transcript retention | the daemon, at boot, switchable on the Claude page | `~/.claude/settings.json` |
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
never calls a blocking tool, and reports to the orchestrator with evidence. It is never
overwritten, so edits on the box stick.

### The standing rules

`~/.claude/skills/metro-orchestrator/SKILL.md` holds the rules: read `addressed` before
answering, react first, delegate everything that is work, never wait on the terminal, report
like a relay, keep going. The daemon writes it once from the copy the plugin carries, and the
plugin's `SessionStart` hook loads its body into every session, so the agent does not have to
invoke the skill. Edit it on the Skills page to change the rules on that box; the plugin's copy
is only the fallback when the file is gone.

## Privacy and data retention

On by default, switchable on the Claude page. The daemon merges into `~/.claude/settings.json`:

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

## Check it

- **Claude page**: the Setup block lists the guard, the worker, the rules and the privacy
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
