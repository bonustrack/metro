# Chats on metro.box

Status: built on 2026-11-27 (Less: "start a chat with an agent from the Metro UI, like claude.ai").
Owner's decisions, asked before the build:

- **Each chat is its own Claude Code session** on the agent's server (same home, memory, skills and
  connectors as the agent), resumed when someone writes again. It does not see the agent's chat
  networks, and they do not see it. Text streams and tool calls show as they happen.
- **"Accessible for anyone" means anyone in the organization.** Nothing is ever public.
- **Any member can start a chat** with any agent that has a server. The person who started a chat,
  or an organization admin, renames, shares and deletes it.

## The shape

```
page ──(1) POST /api/chats/<id>/messages ──> api.metro.box   stores the message sealed,
     <─────────── send ticket ──────────────                 answers a short signed ticket
page ──(2) POST /api/chat/turns {ticket, text} ──> the box   checks the ticket offline,
                                                             runs `metro chat` as the agent
page ──(3) POST /api/chat/turns/<msg>/events (long poll) ──> the box: parts as they come
box  ──(4) POST /api/agents/chats/reply (MetroAgent signed) ──> api.metro.box stores the reply sealed
```

- **api.metro.box is the authority** on who may read and write a chat. The box never decides it:
  it only accepts a **chat ticket** that api.metro.box signed for this person, this chat, this
  agent and this organization.
- **The box streams**; api.metro.box stores. A reply keeps running and is saved when the page is
  closed; reopening the chat attaches to the live reply again.
- An **agent without a server** cannot chat yet (409, and the page says so).

## Storage (api.metro.box, migration `0034_chats`)

- `chats` (owner, agent, `created_by`, sealed `title`, `shared` `private` or `organization`,
  `created_at`, `updated_at`), `chat_members` (who was added), `chat_pins` (one row per person and
  chat: a pin is personal), `chat_messages` (`seq`, `role` `user` or `assistant`, `author` for a
  user message, `reply_to` for a reply, sealed `body`, `at`; one reply per message).
- **Every title and message body is sealed** with `METRO_CONNECTORS_KEY` (AES-256-GCM, purpose
  `metro-chat/v1`, additional data owner and `<chat>/<message>` or `<chat>/title`), so a value
  copied to another chat or organization does not open. Without the key every chat route answers
  503. Ids, times, roles and who wrote are kept in clear.
- A chat is deleted with its agent (cascade) and when its agent moves to another organization
  (`dropAgentChats` in the move's transaction, `chats_agent_idx`). Nothing is deleted by time.
- `chat_reads` (`0036_chat_reads`: chat, user, `seen_seq`, cascading with the chat) keeps how far each
  person has read each chat: reading a chat page moves it to its newest message (never back), but
  not a read the page makes while it is not in front (`?seen=0`: a hidden tab, or the phone app in
  the background, where react-query's focus follows `AppState`, `lib/app-focus.ts`). The migration
  marked every existing chat read for its starter, the people added and, for a chat shared with the
  organization, every member. Each listed chat carries `activity` (its newest message, found per
  chat through the `(chat, seq)` index): `working` while that message is a person's and under 130
  minutes old, counted from Try again too (it moves `updated_at`), so a message the box never got
  does not look busy forever (the box's 2-hour cap plus its 10 minutes of save retries); `unread`
  when it is a reply past what this person has read, else null. Reading a chat page also updates
  that chat's `activity` in the cached list at once. The list shows `working` as a gray dot that pulses in opacity only, and
  `unread` as a still white dot (not for the chat open on screen); it re-reads every 10 s while a
  chat is working, else every 30 s, and once more when an open chat's reply is saved.
- The list answers 200 chats at most, the person's pinned ones first, so a pin never falls off; a
  chat page answers its last 500 messages, newest first within 4 MiB of sealed bodies (the newest
  message always), so one read stays bounded. A person starts at most 5,000 chats per organization
  (409 after). A new message is refused with 409 while the newest message of the chat is a user
  message without a reply (checked inside the insert's transaction, so two posts racing cannot both
  land): every message gets its own reply, in order, and Try again is how a stuck one moves on. A title that cannot be opened reads `This title could
  not be read.`, never an empty title.

## Who sees what

- A chat is visible to its starter, the people they added (members of the organization only, 50 at
  most) and, when `shared` is `organization`, every member. Everyone who sees a chat can write in
  it and pin it. Only the starter or an admin of the organization changes it (title, sharing,
  people) or deletes it, and an admin only sees the private chats of others it was added to.
  A person who left the organization never blocks a change of people or sharing: the next change
  drops them from the chat, while adding anyone outside the organization is still a 400.
- Every read checks the token's organization; a chat of another organization, or one not shared
  with you, is a 404, never a 403 (no existence oracle).

## Chat tickets (`@metro-labs/http/chat-ticket`)

- RS256 with Metro's sign-in key (`METRO_AUTH_SIGNING_KEY`), so a box verifies them with the key set
  it already keeps for sign-in. Header `typ: metro-chat`, `aud: metro-chat`: a chat ticket never
  passes as a sign-in token (those need `typ: JWT` and a `sid`), and a sign-in token never passes
  as a ticket.
- Claims: organization, agent row id, chat, user, the user's name, `act`, a `jti`.
  - **send** (2 minutes): also the message id and the SHA-256 of its text. The box refuses another
    text, another person (the bearer's `sub` must match), another agent (its enrolled server id),
    another organization (`.owner`), and a ticket already used (`jti` kept until it expires).
  - **view** (2 minutes): reading a live reply, stopping it, answering its approvals. The page gets
    a fresh one with every read of the chat.
- Refusals are 403, never 401, so a stale ticket never signs the page out.

## The turn on the box (`apps/daemon/src/chat/`)

- `POST /api/chat/turns {ticket, text}` starts `metro chat` as the agent (`claude/chat-process.ts`:
  `metroCli(['chat'])` through `asAgent`, in a memory scope of a quarter of the session's), sends
  `{t: 'turn', prompt, resume}` on its stdin, and reads JSON lines from its stdout. One reply per chat
  at a time (409), at most 3 at once per box (429), 2 hours at most. In a shared chat the prompt starts
  with `<name>: `. **A box that expects an agent user and has none refuses (503)**, so a chat never
  runs as `metro`. The ticket's `jti` is spent only once the turn started, so a 409 or 429 leaves the
  same ticket usable.
- **Ending a turn ends its processes.** `metro chat` reports `{t: 'pid', pid, group}` (its own pid,
  then the runner's process group). Stop writes `{t: 'stop'}`; a turn still there 15 s after a stop,
  after `done` or at the 2-hour cap gets SIGTERM, then SIGKILL every 15 s until it exits, sent with `kill` run as the
  agent (`signalChatTurn`; the daemon, as `metro`, cannot signal the agent's processes itself, and a
  signal to `sudo` is no reliable way to reach them). `metro chat` forwards SIGTERM to the
  runner's group and kills the group 10 s later. **A chat stays busy until its process really
  exits**: a failed signal is logged and never ends the turn, so the next message cannot resume the
  same session beside a process that still runs.
- **A reply is settled only when the process has exited and its output has ended**, so lines written
  just before the exit are kept. When something still holds the pipe 15 s after the exit, the runner's
  group gets SIGKILL first, then the reply settles. The runner itself exits only once its stdout is
  empty (`exitFlushed`).
- The chat's MCP side session is never closed to make room or for idleness while one of its requests
  runs (a `tool_call` can take 120 s), so a client re-initializing in a loop cannot cut it.
- **Output is read in lines of at most 1 MiB, split on `\n` only** (`chat/lines.ts`): a longer line
  is dropped and logged by its size, never buffered whole, and U+2028 inside a line stays text. A
  part the daemon cannot read still holds its index as an empty text part (`turnEventOf`), so the
  parts after it are not lost.
- The SDK session id of each chat is kept in `<agents dir>/chat-sessions.json` (2,000 chats), so the
  next message resumes it. A session whose transcript is gone from the box (deleted, or a new box)
  is not resumed: the chat goes on in a fresh session instead of failing on every message.
- **A chat's transcript never shows on the agent's Sessions page**: the box's `/api/claude/sessions`
  routes leave out, and answer 404 for, every session a chat ever used (`hidden` in
  `ClaudeApiDeps`, checked on the path's parts as the router reads them, so `//`, a trailing `/`,
  `raw=1`, `tool=`, PUT and DELETE are all covered, and case-insensitive). The file keeps that list
  (`hidden`) apart from the 2,000 chats it can resume and never drops from it. **An unreadable file
  hides every transcript** and is never written over until it is fixed or removed.
- **An approval a chat causes waits on metro.box only**: the chat's MCP client sends `x-metro-chat: 1`
  and always gets a side session, never the agent's slot, whatever the runner is doing. A channel Ask
  it makes and a connector approval its `tool_call` causes are listed on `GET /api/approvals` but
  posted in no chat network and never told to the agent's own session (see
  `docs/rules/TOOL-POLICIES.md`).
- Live state lives in memory only (`chat/turn.ts`): the parts, the last 4,000 events, the result,
  and whether api.metro.box took the reply (`delivery`: `pending`, `saved`, `failed`). **Saving is
  retried for 10 minutes** with a pause from 3 s doubling to 60 s; a refusal that cannot change (a 4xx
  other than 401, 408, 425 and 429) is not retried. A reply stays while it is being saved and 10
  minutes after. **The same message sent again while its reply is kept is saved again, never run
  again.** A box restart forgets running replies; the page then offers Try again, which asks
  api.metro.box for a new send ticket for the same message.
- `POST /api/chat/turns/<message>/events {ticket, after}` waits up to 25 s for something new and
  answers the events after `after`, or a snapshot of the parts when `after` is older than what is
  kept. `/stop` and `/answer {approval, allow}` write to the process.
- The reply that is saved is fitted to 400,000 UTF-8 bytes (tool output shrinks first), under the
  seal limit and the agent route's body limit. The daemon never logs a reply or the process's
  stderr, only its own `metro chat:` lines.

## `metro chat` and the chat session (`packages/sdk-runner/src/chat-*.ts`)

- `metro chat` prepares the runner store like `metro agent`, takes `headlessEnv` (the gateway, the
  agent key, tool search, the hour of cache) and runs `chat-main.ts` with Bun in its own process
  group. Its stdin and stdout are the protocol above; logs go to stderr.
- The session: `claude_code` preset plus the Harness system prompt and `CHAT_RULES`, the agent's
  settings, skills and memory, the `metro` MCP server over HTTP (a side session of the daemon:
  tools only), the Gateway page's model and only that one (`applyFlagSettings`, as the runner), the
  agent's permission mode, `AskUserQuestion` and the plan tools off. `METRO_SESSION=chat` makes the
  guard hook and the session-start rules stand aside: a chat works on its own thread and shows its
  tool calls.
- Parts (`@metro-labs/core/chat`): `text`, `tool` (name, input and result as text, 4,000 characters
  each; ids and names made safe with `chatName`), `approval` (waiting, allowed, denied). Thinking and
  a worker's inner messages are never shown. When the permission mode asks, the approval waits in the
  chat itself (30 minutes, then denied) and anyone who can read the chat answers it there; it is not
  listed on the agent's Home, so a private chat stays private.
- Its main thread still thinks at the gateway's main-thread effort (`low` by default): the gateway
  cannot tell a chat from the agent's front yet.

## The page (`apps/app/src/components/discussions/`)

- A **Chats** section in the rail (first, above Agents) and a tab on the phone. The list pane shows
  Pinned then Recent; `#/<org>/chat` is a new chat (the list on a phone), `#/<org>/chat/new/<agent>`
  starts one with an agent picked, `#/<org>/chat/<id>` is one chat. `chat` is a reserved slug.
- The chats home (`#/<org>/chat`, wide screen) is the new chat, like Claude's and ChatGPT's: a greeting
  by first name and time of day, then one composer centred on the screen (720 px, two rows to start)
  whose bottom bar holds the agent (a dropdown; the last one used is remembered) and Add people (the
  same picker as Share; they join with the first message, `members` on `POST /api/chats`), with send
  at the bottom right. While the page loads a chat or the agents, the main pane shows one spinner in
  the middle of the screen, never skeleton rows.
- The page re-reads an open chat from api.metro.box every 10 s, only while its tab is visible, so what
  others (or the same person in another window) write shows up. The long poll to the box is cut
  after 40 s and retried, and an expired view ticket is renewed. A message the page adds to its copy
  of the chat (or a chat it adds to the list) first cancels the read in flight, so an older answer
  never wipes it.
- The page gates the composer on the box: no server, offline, stopped, updating, or older than
  `CHAT_SINCE` (`0.1.0-beta.341`). The field is locked, with its usual placeholder, until the box's
  status is known (`chatGate` in `lib/chat-queries.ts`). Send stays off while a reply runs, and until the box says the finished reply is saved on
  metro.box (`replyHolds` in `lib/chat-turn.ts`), so a follow-up never lands before the reply it
  follows. While the page does not know yet whether a reply runs, the reply shows a placeholder line,
  never Thinking or Stop. A 409 from metro.box on a new message (the last one has no reply yet) shows
  under the composer like any failed send, keeps the typed text, and re-reads the chat. After every
  send the page re-reads the chat, so a reply saved just before it is never dropped from the page.
  A chat that answers 404 (deleted, or no longer shared) shows the missing state at once, even when
  the page still holds a copy.
- A send the box answers with 409 (a reply already runs in this chat) is watched, not reported as a
  failure. Try again after a failed watch only watches again; after a failed send, or when the box
  no longer knows the reply, it asks metro.box for a new send ticket. Its error shows under it. A
  Stop pressed while the message is still being handed to the box is sent as soon as the box has it.
  When a read brings the new message in before its post answered, the watch hands it to the box as
  soon as the send ticket arrives.
- A chat page is one centred column of 760 px (an exception to the left-aligned pages, asked for on
  2026-11-27, like ChatGPT). Replies render with the app's `MarkdownBlock`, like transcripts, except
  that **an image is never loaded**: it shows as a link with its alt text or address (`linkImages`),
  since a reply can carry text a connector brought in, and an image address would send data out. The
  composer is docked at the bottom of a chat page (the shell's `dock` mode: the page fills the screen, and a phone hides the
  tab bar there), styled like Stage's: large text, a rounded box, a round send or stop button.
- A failed reply says so in plain words; the raw error shows only with technical details on.
- Each message shows its time (24-hour, `3xs`, like Stage). Under an agent reply: Copy (its text,
  never its tool calls) and how long the reply ran (`ms`, measured on the box from start to end and
  saved with the reply; older replies show none). The chat page has a compact sticky top bar across
  the whole pane (title, agent and sharing, the menu).
- A connector call (`tool_call`) shows the connector's logo and name (the client's `connectorOfKey`
  over the connectors assigned to the chat's agent), and the tool. When mcp.metro.box answers
  `needs_approval`, the row shows one card per approval link in the answer whose listed approval is
  this row's own call (the same connector tool, and the same arguments when the box lists them; an id
  steered into a result for another call shows nothing), while the box still lists it as waiting: the same read as the agent's Home (`['approvals', base]`, `useApprovalLists`), shown
  only from a read that worked, is fresh and comes from a live box. The card takes its connector,
  tool and arguments from that listed approval and lists every argument under Everything in this
  call, like Home. Approve and continue answers it on the box (`POST /api/approvals/<id>`), refreshes
  that read and sends "I approved it (<id>). Go on." so the agent repeats the call with the approval
  id (the chat rules tell it to): at once when no reply holds the chat, else once that reply is saved
  (`holdGoOn` in `lib/chat-sends.ts`, posted from the watch's end). A failed answer keeps the buttons with
  the error under them; an approval that worked but whose message could not be sent says it was
  approved. A permission prompt inside a reply lists every argument too, and keeps its answer until
  the reply reports it. It still shows on the
  agent's Home like every connector approval.

## What private does not cover

A chat runs as the agent, with the agent's tools, on the agent's box. Its transcript is a file in the
agent's home: an admin with the Terminal or Files can read it, the agent can read it when someone asks
it to in another conversation, and the daily memory routine may file facts from it into the agent's
memory, which members can read. Private means other members do not see the chat on metro.box. An
approval the chat's work asks for (a connector or channel Ask) waits on the agent's Home like any
other approval, with its tool and every argument, for every member: anyone in the organization can
answer it there, as the approvals rule says.

## Local test

A local stack (own Postgres, api, daemon and app on this Mac) needs `METRO_API_HOST` on the api
(the host it checks agent signatures against, like `METRO_MCP_HOST`) and `METRO_API_URL` on the
daemon (where it sends its signed requests), plus `METRO_AUTH_BASE` for the sign-in keys.
