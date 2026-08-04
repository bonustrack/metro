# Orchestrator-only main thread

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

## The boundary

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

## Before you start

### `jq` is a hard dependency, and it fails open

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

### Back up, and validate the JSON on both sides of the edit

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

## 1. The hook script

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

## 2. Wire it into `settings.json`

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

## 3. Register Metro under the server name `metro`

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

## 4. The `worker` subagent

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

## Design points that are easy to get wrong

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

### No foreground subagents

`Agent` with an explicit `run_in_background: false` is denied on the main thread. A
foreground subagent blocks the thread until it returns, so inbound messages are neither
seen nor acknowledged for the whole run, which is exactly the silence this setup exists
to prevent. Background is the tool's default, so the check matches only an explicit
boolean `false`: omitted or `true` is untouched.

## Test it before you trust it

### Layer 1, offline

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

### Layer 2, live, and it cannot be delegated

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

## What it costs

This is a real trade-off, not a free win. Afterwards the main thread cannot read a file,
run a command, edit anything or fetch a URL, ever, including to fix this setup. Every
piece of work is a delegation, every fact in a reply is a worker's claim rather than
something the orchestrator saw, and a task that would have been one `grep` is now a
round trip. What it buys is a thread that is never too busy to answer, which for an
agent whose job is to be in conversations is usually the better half of the deal.
