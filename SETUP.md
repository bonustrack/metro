# Setup

Two Claude Code setups Metro is usually run in. They are independent — apply either,
both, or neither. Neither is a Metro feature and the daemon runs fine without both.

1. [Orchestrator-only main thread](#orchestrator-only-main-thread) — a `PreToolUse`
   hook that keeps the main thread free to answer chat while subagents do the work.
2. [Privacy and data retention](#privacy-and-data-retention) — the environment
   variables that stop Claude Code's non-essential network traffic, the one that has
   to go with them or Metro stops working, and the local-disk retention that none of
   them touch.

## Orchestrator-only main thread

> A `PreToolUse` hook that leaves the main Claude Code thread able to do exactly two
> things: delegate to subagents, and talk on Metro. Everything else is denied there and
> has to be handed to a subagent, which keeps full tool access.

An agent connected to Metro is holding real conversations while it works, and inbound
messages are only noticed between tool calls. A main thread that greps the codebase,
runs the build and reads files is a main thread that is busy, and a busy one does not
see a message for minutes at a time. This setup enforces the split in the harness
rather than in good intentions: the main thread receives, acknowledges, delegates and
relays; subagents do the work.

It is a Claude Code configuration, not a Metro feature. Nothing here touches the
daemon and Metro runs fine without it. It lives in this repo because it is the shape
Metro is usually run in, and because the parts that are easy to get wrong are easy to
get wrong silently.

Four pieces:

1. a `PreToolUse` hook script,
2. the `settings.json` entry that wires it in,
3. the Metro MCP registration, under the server name `metro`,
4. a local `worker` subagent definition.

Verified on Claude Code 2.1.221, bash 5.2, jq 1.7, Linux.

### The boundary

Allowed on the main thread:

| Tool | Why it stays |
| --- | --- |
| `Agent`, `Workflow` | Delegation. The whole point, and the only way back if you break something. |
| `mcp__metro__*` | Talking to the outside world. |
| `ToolSearch` | Loads schemas for deferred tools. Without it the Metro tools cannot be called at all. |
| `Skill`, `ScheduleWakeup`, `Monitor`, `Cron*`, `Task*` | Scheduling and tracking. They coordinate work rather than perform it. |
| `Read`, images only | So screenshots someone sends can be looked at directly. |

Denied on the main thread: everything else. `Bash`, `Write`, `Edit`, `Grep`, `Glob`,
`WebFetch`, `Read` of any text file.

Denied everywhere, main thread and subagents alike: `AskUserQuestion`, `ExitPlanMode`,
`EnterPlanMode`. Nobody watches the terminal around the clock, so a blocking prompt is
an indefinite stall. Ask over chat instead and keep working.

Denied on the main thread only: `Agent` with `run_in_background: false`. See
[below](#no-foreground-subagents).

**The escape hatch, before you start.** Once the guard is live the main thread cannot
edit the guard, because editing is a denied tool. The only route back is a subagent.
That is why the hook must always allow `Agent`, and why no rule should ever be added
that could deny it.

### Before you start

#### `jq` is a hard dependency, and it fails open

Every branch of the hook shells out to `jq`. With `jq` off `PATH` the script writes a
"command not found" to stderr, emits **nothing** on stdout and exits 0, which Claude
Code reads as "no decision", so **every tool is allowed and the guard silently does
nothing**. It looks installed. It enforces nothing.

There is no way to tell that apart from a working setup by reading the config, so check
the binary and then check a real denial:

```sh
command -v bash jq && jq --version
```

The self-check in [Test it before you trust it](#test-it-before-you-trust-it) is what
actually proves the guard is live. Do not skip it.

#### Back up, and validate the JSON on both sides of the edit

This hook governs the main thread's only remaining capability, and a mistake cannot be
repaired from the main thread. Back up first, with a timestamp:

```sh
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/.claude/backups
cp ~/.claude/settings.json ~/.claude/backups/settings.json.bak-$STAMP
cp ~/.claude/hooks/main-thread-guard.sh \
   ~/.claude/backups/main-thread-guard.sh.bak-$STAMP 2>/dev/null   # if one exists
jq -e . ~/.claude/settings.json >/dev/null && echo "settings.json parses OK before edit"
```

If that `jq -e` fails, stop. Do not layer an edit on a file that is already broken.

If a `PreToolUse` hook is already wired up, read it and merge rather than replace.
Multiple `PreToolUse` entries all run, and any one of them can deny.

### 1. The hook script

Write this to `~/.claude/hooks/main-thread-guard.sh`:

```bash
#!/usr/bin/env bash
# PreToolUse guard: the main thread is an orchestrator only.
#
# It may delegate (Agent, Workflow) and talk on metro. Everything else —
# Bash, Write, Edit, Grep, Glob, WebFetch, ... — is denied and (Read is
# allowed for image files only, so screenshots can be viewed directly.)
# must be handed to a subagent or workflow agent instead.
#
# Subagents and workflow agents are otherwise untouched: their PreToolUse
# payloads carry an `agent_id` field, which main-thread payloads omit entirely.
#
# Separately, tools that block waiting on the terminal are denied EVERYWHERE,
# main thread and subagents alike. Nobody watches the terminal around the
# clock, so a blocking prompt is an indefinite stall. Ask over metro instead.
set -uo pipefail

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)

deny() {
  jq -nc --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# --- Denied everywhere: anything that waits on a human at the terminal ---
case "$tool" in
  AskUserQuestion | ExitPlanMode | EnterPlanMode)
    deny "$tool blocks the session waiting on the terminal, and nobody is watching it. Decide using your best judgement and state the assumption, or ask over Discord with mcp__metro__ask / mcp__metro__send and keep working in the meantime."
    ;;
esac

# --- Subagents may do anything else ---
agent_id=$(printf '%s' "$payload" | jq -r '.agent_id // empty' 2>/dev/null)
[[ -n "$agent_id" ]] && exit 0

# --- Main thread: no foreground subagents ---
# A subagent spawned with run_in_background:false blocks this thread until it
# finishes, so inbound metro messages are neither seen nor acknowledged for the
# whole run. Background is the tool's default, so this matches ONLY an explicit
# boolean false: omitted or true is untouched, as is every other tool. jq -e
# exits non-zero on false/null and on any parse error, so THIS branch never
# fires on a malformed payload and never locks the orchestrator out of
# delegating. Such a payload is not allowed either: it has no tool name at
# all, so it falls through to the catch-all deny at the bottom.
if [[ "$tool" == "Agent" ]] &&
  printf '%s' "$payload" | jq -e '.tool_input.run_in_background == false' >/dev/null 2>&1; then
  deny "Foreground subagents blind the main thread: it cannot see or acknowledge inbound metro messages until the agent finishes. Re-issue the identical Agent call with run_in_background: true, then wait for the task notification."
fi

# --- Main thread: orchestration and messaging only ---
case "$tool" in
  # Delegation.
  Agent | Workflow) exit 0 ;;
  # Talking to the outside world.
  mcp__metro__*) exit 0 ;;
  # Schema loading for deferred tools — without this the metro tools above
  # cannot be called at all, since their schemas are fetched on demand.
  ToolSearch) exit 0 ;;
  # Skills, plus the scheduling and tracking tools they depend on. These
  # coordinate work rather than perform it, so they stay in the main thread:
  # /loop and /schedule have to run here or the loop does not exist at all.
  Skill | ScheduleWakeup | Monitor) exit 0 ;;
  CronCreate | CronList | CronDelete) exit 0 ;;
  TaskCreate | TaskGet | TaskList | TaskOutput | TaskStop | TaskUpdate) exit 0 ;;
  # Images only. The orchestrator needs to see screenshots the user sends,
  # and a description relayed through a subagent loses too much. Text files
  # stay denied, so the orchestrator boundary holds. .svg and .pdf are
  # deliberately excluded — both are text under the hood and would be a
  # read-anything bypass.
  Read)
    fp=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
    case "${fp,,}" in
      *.png | *.jpg | *.jpeg | *.gif | *.webp | *.bmp) exit 0 ;;
    esac
    ;;
esac

deny "Main thread is orchestrator-only; $tool is not available here. Delegate the work to a subagent via the Agent tool, or to a Workflow — both have full tool access — and report results over metro."
```

Then make it executable and syntax-check it:

```sh
chmod +x ~/.claude/hooks/main-thread-guard.sh
bash -n ~/.claude/hooks/main-thread-guard.sh && echo "syntax OK"
```

### 2. Wire it into `settings.json`

Merge this into `~/.claude/settings.json` rather than replacing the file:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<your-home>/.claude/hooks/main-thread-guard.sh",
            "statusMessage": "Checking orchestrator boundary"
          }
        ]
      }
    ]
  }
}
```

Three things to get right:

- **No `matcher` key.** That is deliberate. An unmatched `PreToolUse` entry fires for
  every tool, including MCP ones, which is what makes deny-by-default work. Adding a
  matcher silently narrows the guard to a subset and leaves the rest wide open.
- **`command` is an absolute path**, written out in full. `~` is not expanded here, so
  substitute the real home directory.
- `statusMessage` is cosmetic, just the line shown while the hook runs.

Put it in **user** settings (`~/.claude/settings.json`) rather than project settings, so
it applies to every session whatever the working directory is.

Then validate again and diff against the backup, so the change is visible rather than
assumed:

```sh
jq -e . ~/.claude/settings.json >/dev/null && echo "settings.json parses OK after edit"
jq '.hooks.PreToolUse' ~/.claude/settings.json
diff ~/.claude/backups/settings.json.bak-$STAMP ~/.claude/settings.json
```

A `PreToolUse` deny wins regardless of permission mode, including a permissive default.
Do not expect a relaxed permission setting to let something slip past, and do not
tighten permissions expecting that to substitute for the hook.

### 3. Register Metro under the server name `metro`

After this change Metro is the only way the main thread can talk to anyone, so register
it before the guard goes live. The web UI hands out a paste-ready line for the agent's
key; see [Connecting a client](README.md#connecting-a-client) for the endpoint shape.

```sh
claude mcp add --transport http metro "https://<your-metro-host>/mcp?token=<agent-key>"
```

**The server name must stay `metro`.** The hook allowlists by the tool-name glob
`mcp__metro__*`, and Claude Code derives that prefix from the MCP server name. Register
the same endpoint as `bot` and every Metro tool is denied on the main thread, with a
message about the orchestrator boundary that gives no hint the name is the problem.
`metro` is also the constant the UI emits for every agent, so the two conventions agree.

Two more:

- Scope is your call. `claude mcp add` defaults to registering the server for the
  directory it was run in; add `--scope user` if the orchestrator session starts from
  more than one directory.
- Use the locally registered HTTP MCP, not a managed claude.ai connector for the same
  service. A managed connector surfaces under a different tool prefix, which this hook
  denies.

Verify with `claude mcp list` and confirm the name reads `metro`. Keys belong in the
registration command and nowhere else: not in a file that gets committed, not in a chat
message, not in a report.

### 4. The `worker` subagent

`worker` is **not** a built-in subagent type, it is a local file. Without it, every
delegation with `subagent_type: "worker"` fails to resolve, and since delegation is the
main thread's only real capability that is close to a hard stop.

Write this to `~/.claude/agents/worker.md`:

```markdown
---
name: worker
description: Default execution agent for delegated work. Full tool access and maximum reasoning effort. Use for any substantive task the orchestrator main thread cannot perform itself — reading and writing code, running commands, research, analysis.
effort: xhigh
---

You are a worker agent. The main thread that dispatched you is an orchestrator with no file, shell, or network access — it can only delegate and relay messages. That means you are where the actual work happens, and the quality of your output is the quality of the result.

Work to completion. Do not hand back a partial answer with a suggestion that someone else finish it; there is no one else. If part of the task is genuinely blocked, complete every other part in full and say plainly what you left undone and why.

Never call AskUserQuestion or ExitPlanMode. They are blocked by policy, because nobody is watching the terminal around the clock and a blocking prompt stalls indefinitely. When you hit an ambiguity: do everything that does not depend on it, then choose the most reasonable interpretation, state the assumption explicitly in your report, and continue.

Your final message is a report to the orchestrator, not a message to a human. It gets relayed onward, so make it self-contained and concise. Lead with the outcome. Include concrete evidence — command output, file paths with line numbers, test results — for anything you claim to have verified. Report failures faithfully: if a test failed, say so and show the output; if you skipped a step, say that too.
```

The body matters as much as the frontmatter. The main thread can no longer verify
anything itself, so a worker's report is the only evidence it will ever have. The
report discipline in that last paragraph is what keeps the arrangement honest.

### Design points that are easy to get wrong

- **The main-thread test is the absence of `agent_id` in the payload.** Subagent
  payloads carry it, main-thread payloads omit it entirely. That one line is what keeps
  subagents fully capable, and it is also why the guard cannot be tested from a
  subagent.
- **`ToolSearch` has to be allowed.** Metro's tools are deferred: their schemas are
  fetched on demand, so denying `ToolSearch` denies every Metro tool by starvation,
  with an error that points at the wrong thing.
- **The server name is load-bearing** for the same reason the tool prefix is. See
  [above](#3-register-metro-under-the-server-name-metro).
- **`Read` is images only, and `.svg`/`.pdf` are excluded on purpose.** Both are text
  underneath, so allowing them would turn the image carve-out into a read-anything
  bypass. Raster extensions only.
- **The default branch denies**, so any tool not named is denied. If other coordination
  tools have to live on the main thread, add them to the allowlist rather than
  weakening the default.
- **A payload that does not parse is denied, not allowed.** Only the
  `run_in_background` check fails open on a parse error, which is deliberate so a
  malformed payload can never block delegation. A payload that fails to parse at all
  yields an empty tool name and falls through to the catch-all `deny`, whose message
  reads a little oddly with a blank tool name. That is a denial, which is the safe
  direction.

#### No foreground subagents

`Agent` with an explicit `run_in_background: false` is denied on the main thread. A
foreground subagent blocks the thread until it returns, so inbound messages are neither
seen nor acknowledged for the whole run, which is exactly the silence this setup exists
to prevent. Background is the tool's default, so the check matches only an explicit
boolean `false`: omitted or `true` is untouched.

### Test it before you trust it

#### Layer 1, offline

Drive the script directly with synthetic payloads, without going through the harness.
Every line should print the verdict in its label:

```sh
H=~/.claude/hooks/main-thread-guard.sh
t() { printf '%-38s => ' "$1"; o=$(printf '%s' "$2" | "$H"); [ -z "$o" ] && echo ALLOW \
      || echo "$o" | jq -r .hookSpecificOutput.permissionDecision; }

t "main Bash            (expect deny)"  '{"tool_name":"Bash","tool_input":{}}'
t "main Agent           (expect ALLOW)" '{"tool_name":"Agent","tool_input":{}}'
t "main Agent bg=false  (expect deny)"  '{"tool_name":"Agent","tool_input":{"run_in_background":false}}'
t "main mcp__metro__send(expect ALLOW)" '{"tool_name":"mcp__metro__send","tool_input":{}}'
t "main Read foo.png    (expect ALLOW)" '{"tool_name":"Read","tool_input":{"file_path":"/x/a.png"}}'
t "main Read foo.md     (expect deny)"  '{"tool_name":"Read","tool_input":{"file_path":"/x/a.md"}}'
t "sub  Bash            (expect ALLOW)" '{"tool_name":"Bash","agent_id":"a1","tool_input":{}}'
t "sub  AskUserQuestion (expect deny)"  '{"tool_name":"AskUserQuestion","agent_id":"a1","tool_input":{}}'
```

```
main Bash              => deny
main Agent             => ALLOW
main Agent bg=false    => deny
main mcp__metro__send  => ALLOW
main Read foo.png      => ALLOW
main Read foo.md       => deny
sub  Bash              => ALLOW
sub  AskUserQuestion   => deny
```

If **every** line says `ALLOW`, the guard is not working, and the likeliest cause is a
missing `jq`: no `jq`, no output, everything allowed. Check `command -v jq` again.

#### Layer 2, live, and it cannot be delegated

A subagent's payload carries `agent_id`, so a subagent testing the guard exercises the
exempt branch and proves nothing about main-thread behaviour. These checks have to be
issued from the main thread itself, after the settings are in place:

1. Call a harmless Metro tool, a `read` on some line. It should work.
2. Spawn a trivial `Agent` in the background. It should be allowed and should come back
   with a task notification.
3. Spawn the same `Agent` with `run_in_background: false`. It should be denied, with the
   foreground-blinding reason.
4. Try something inert like a `Bash` `echo hi`. It should be denied, with the
   orchestrator-only reason.
5. Have a subagent run a couple of commands and read a file. All fine, confirming
   subagents are unaffected.

Restart the session after adding the hook and the MCP server. Neither is picked up
live, so a guard that looks dead may just be a stale session.

### What it costs

This is a real trade-off, not a free win. Afterwards the main thread cannot read a file,
run a command, edit anything or fetch a URL, ever, including to fix this setup. Every
piece of work is a delegation, every fact in a reply is a worker's claim rather than
something the orchestrator saw, and a task that would have been one `grep` is now a
round trip. What it buys is a thread that is never too busy to answer, which for an
agent whose job is to be in conversations is usually the better half of the deal.

## Privacy and data retention

> Four environment variables that cut Claude Code's non-essential network traffic,
> one of which exists only to undo the damage the other three do to Metro, plus the
> local-disk retention that none of them touch.

This half stands alone and applies to any Claude Code install, with or without the
hook above. The only Metro-specific part is [the hatch](#disabling-telemetry-disables-channels-which-breaks-metro),
and that matters to anyone running an MCP server that uses Claude channels.

Verified on Claude Code 2.1.222, Linux, against the shipped binary and by running
`claude doctor` under each variable. Anthropic's own documentation is the reference
for anything with legal weight; where it is silent, the observed behaviour below is
marked as observed.

### The configuration

Merge this into `~/.claude/settings.json` rather than replacing the file, then
restart the session — `env` is read at startup only.

```json
{
  "env": {
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": "1"
  }
}
```

| Variable | What it does |
| --- | --- |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | The umbrella. Puts the client in "essential traffic only" mode. |
| `DISABLE_TELEMETRY` | Usage metrics off. Redundant under the umbrella. |
| `DISABLE_ERROR_REPORTING` | Error reports off. Redundant under the umbrella. |
| `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF` | The hatch. Undoes the collateral damage the others cause. Do not skip it. |

Validate and confirm, the same way as [above](#back-up-and-validate-the-json-on-both-sides-of-the-edit):

```sh
jq -e . ~/.claude/settings.json >/dev/null && jq '.env' ~/.claude/settings.json
claude doctor    # after a restart
```

`claude doctor` is the check that does not require guessing. With the umbrella set it
reports `Auto-updates: disabled (set by env: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)`
and `Feature-flag evaluation disabled (disabled by …)`, naming the variable
responsible. Note that it reports feature-flag evaluation as disabled **even when the
hatch is working** — it describes the network path, which the hatch deliberately does
not restore. Do not read that line as the hatch having failed.

### The umbrella supersedes the other two

One function decides the mode, and it checks the umbrella first and returns
immediately, so `DISABLE_TELEMETRY` is not even read when the umbrella is set.
Error reporting is suppressed on its own path by either `DISABLE_ERROR_REPORTING`
or essential-traffic mode, so the umbrella covers that too.

Setting all three is harmless and redundant. Keep them explicit anyway: the umbrella
is a single flag whose scope could narrow in a later release, and the other two state
the intent independently of it.

`DISABLE_ERROR_REPORTING` is the only one of the three that is safe on its own. It
does not touch feature-flag evaluation. The other two do, which is the section after
next. Error reporting is also off by default already unless you are signed in with a
Pro or Max subscription on 2.1.198 or later and connecting directly to the Claude API,
so on many installs that variable changes nothing.

### These are presence checks, not booleans

The three privacy variables and the hatch are read as bare truthiness on the raw
string — `if (process.env.X)`. Any non-empty value counts as **on**, including the
ones that read as off:

```
DISABLE_TELEMETRY=1                              => telemetry off
DISABLE_TELEMETRY=0                              => telemetry off
DISABLE_TELEMETRY=false                          => telemetry off
DISABLE_TELEMETRY=                               => telemetry ON  (empty string is falsy)
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=false   => essential-traffic mode ON
```

Observed, by running `claude doctor` under each and reading the
`Feature-flag evaluation disabled (disabled by …)` line.

The only way to turn one off is to **remove the key**. Setting it to `"0"` or
`"false"` turns it on and reads in review as if it were off, which is the footgun.
This is not the house convention either: `DO_NOT_TRACK`, which is a synonym for
`DISABLE_TELEMETRY` here, *is* parsed properly (`1`/`true`/`yes`/`on`), so the
inconsistency is easy to walk into.

### Disabling telemetry disables channels, which breaks Metro

This is the one to read even if you skip the rest.

Turning telemetry off also disables **feature-flag evaluation**. That is documented,
though only in passing and only in terms of Remote Control. The consequence that is
not documented is the size of the blast radius: with evaluation off, *every* flag
falls back to its compiled-in default, and the flag that enables Claude channels
defaults to **off**.

The chain, end to end:

1. Any of `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY` or
   `DO_NOT_TRACK` puts the client in a non-default traffic mode.
2. In that mode the flag reader short-circuits and returns each flag's built-in
   default without consulting anything.
3. The channels flag's built-in default is `false`.
4. The MCP channel gate sees channels disabled, **removes the channel notification
   handler**, and shows a toast reading `Channels are not currently available` for
   twelve seconds.

Metro then stops registering on the next restart or MCP reconnect. Nothing else
changes: the daemon is healthy, `claude mcp list` shows the server connected, the
tools still work. Only inbound delivery is gone, and the only symptom is a toast that
is easy to miss and gone in twelve seconds.

`CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1` is the fix. It makes the flag reader
fall through to the **local disk cache** of previously-fetched flags instead of
short-circuiting to defaults. It opens no network path — the fetch stays gated on the
same telemetry check and stays off — and it is inert unless telemetry is off, so it
cannot re-enable anything on a normal install.

Three conditions before you rely on it:

- **The disk cache has to be populated.** It is written only by a successful flag
  fetch. On a machine where telemetry has been off since first launch there is
  nothing to read and the hatch does nothing. Check before you trust it:

  ```sh
  jq '{cached: (.cachedGrowthBookFeatures | length), at: .cachedGrowthBookFeaturesAt}' ~/.claude.json
  ```

  A count of zero, or no key at all, means run once without the privacy variables to
  populate it, then put them back.

- **First-party auth only.** The hatch is ignored on Bedrock, Vertex, Foundry and
  gateway sessions. It does not matter there, because channels are refused outright
  on third-party providers anyway (`Channels are not available on Bedrock, Vertex, or
  Foundry`) — so Metro's channel does not work on those providers at all, hatch or no
  hatch.

- **The cache never expires, and never refreshes.** There is no staleness check on the
  read, so it is frozen at whatever the flags were the last time telemetry was on.
  That is stable rather than correct.

**The hatch is undocumented.** It appears in no Anthropic documentation page and
nowhere on the public web. A future release could remove or rename it, at which point
Metro stops registering on the next reconnect with no other signal. Re-check after
Claude Code updates: watch for the toast, and confirm inbound messages still arrive.

### What this buys, and what it does not

What stops leaving the machine: usage metrics, error reports and stack traces,
session-quality surveys, feature-flag fetches, and update checks.

What does **not** stop, and this is the part worth being plain about if you are
reading this for compliance reasons: **prompts, file contents, command output, tool
results and model responses still go to the API.** That is the product working, not
telemetry, and no environment variable here changes it. These flags look more
protective than they are. Server-side retention of that traffic is governed by your
account type and terms, not by this file.

Two further things are explicitly **not** covered by the umbrella and have their own
opt-outs:

- The **WebFetch domain safety check** still sends each requested hostname (hostname
  only, not the path or contents) to `api.anthropic.com`. Opt out with
  `"skipWebFetchPreflight": true` in settings, and pair it with WebFetch permission
  rules if you do.
- **Official plugin marketplace auto-install**. Opt out with
  `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`.

### What stops working

Gated on the umbrella specifically, so setting only `DISABLE_TELEMETRY` leaves these
alone: `/feedback` (and `/bug`, `/share`), `/design-sync`, Projects, Artifacts, memory
sync, automatic updates, and the GitHub PR-status lookups in the statusline — that last
one is worth noting because it is traffic to GitHub, not to Anthropic, refused because
the mode is global rather than per-destination.

Gated on feature-flag evaluation, so `DISABLE_TELEMETRY` alone is enough to break it,
and the hatch restores it: **Remote Control**, plus anything else behind a flag.
`claude remote-control --enable-live-preview` is additionally refused by name.

### Local disk retention, which is the part people miss

Server-side retention controls do nothing about this, and neither do any of the
variables above.

Claude Code writes a **full session transcript to local disk in plaintext** — every
message, tool call and tool result. Anything that passes through a tool lands there:
file contents, command output, pasted text. If a tool reads a `.env` or a command
prints a credential, that value is now in a file on disk. They are not encrypted at
rest; file permissions are the only protection.

Shape of the directory, under `~/.claude/`:

| Path | Contents | Swept? |
| --- | --- | --- |
| `projects/<project>/<session>.jsonl` | Full conversation transcript | yes |
| `projects/<project>/<session>/subagents/` | Subagent transcripts | yes |
| `projects/<project>/<session>/tool-results/` | Large tool outputs spilled to files | yes |
| `file-history/<session>/` | Pre-edit snapshots of files Claude changed | yes |
| `paste-cache/`, `image-cache/` | Large pastes and attached images | yes |
| `debug/`, `plans/`, `tasks/`, `session-env/`, `shell-snapshots/` | Per-session working state | yes |
| `history.jsonl` | **Every prompt ever typed**, with timestamp and project path | **no** |

Swept entries are deleted at startup once older than `cleanupPeriodDays`, which
**defaults to 30**. The setting is `cleanupPeriodDays` — there is no
`sessionCleanupDays`, that name does not exist anywhere in the product. Minimum is
`1`; `0` is a validation error, not "off".

```json
{ "cleanupPeriodDays": 7 }
```

`history.jsonl` is the one people miss twice over: it is your entire prompt history
with project paths, and it is **not** covered by `cleanupPeriodDays` at all. It is
kept until something deletes it.

Four things worth doing:

- **Shorten the period.** Set `cleanupPeriodDays` to the smallest number that still
  lets you resume the sessions you actually resume.
- **Encrypt the directory**, or the volume under it. Full-disk encryption on a laptop;
  on a server, an encrypted volume. This is the only thing that helps if the disk
  leaves your control.
- **Never sync it anywhere.** No backup tool, no Dropbox, no cloud drive, and never
  into a repository. A transcript directory is the highest-density collection of
  secrets on the machine, and the sweep does not reach copies.
- **Purge per project** when you are done with one: `claude project purge <path>`
  (2.1.124+) prints a plan and asks before deleting the project's transcripts, its
  per-session state, and its lines in `history.jsonl`. `--dry-run` to preview.

To stop the writes entirely, set `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, which skips both
transcripts and prompt history. The cost is that `--resume` and `--continue` can no
longer find the session, and the session banner will say so. Non-interactively, `-p
--no-session-persistence` does the same for one run. Deny-rules on credential file
reads are the complementary half: what a tool never reads never reaches a transcript.

### Beyond this

Everything above is client-side. For anything stronger, the levers are commercial
rather than configuration, and it is worth being accurate about which is which:

- **Zero data retention** is an arrangement, not a setting. It is not included in the
  standard Enterprise plan and cannot be switched on from an admin panel; Anthropic
  enables it per organization for qualified accounts through your account team.
- **Bedrock, Vertex and Foundry** change *who processes and stores* the traffic — it
  becomes your cloud provider's, under your provider agreement and keys — rather than
  eliminating retention. They also turn telemetry, error reporting and `/feedback` off
  by default, and, as above, they disable Claude channels entirely.

Neither is something to conclude from this document. Check Anthropic's own pages,
which are the authority and are current: [data usage](https://code.claude.com/docs/en/data-usage),
[zero data retention](https://code.claude.com/docs/en/zero-data-retention), and
[the `.claude` directory](https://code.claude.com/docs/en/claude-directory) for the
local-disk half.
