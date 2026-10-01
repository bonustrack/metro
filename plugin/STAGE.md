---
name: stage
description: How to use Stage channels (XMTP groups, https://stage.box) through metro. Create a channel, rename it, add or remove members, set labels and assignees, read its info, and send, reply, react, unreact, delete and read messages. Works only when this agent has an XMTP account in metro.
---

Stage (https://stage.box) is a messenger built on XMTP. A Stage channel is an XMTP group. You use it with the metro tools below (`mcp__metro__<name>`).

**XMTP only.** All of this needs an XMTP account connected to this agent in metro. Check with `list_accounts`: it must show an account under `xmtp`. Many agents have none. Then none of this works: say so plainly and do not try another channel. The owner can add an XMTP channel on https://metro.box.

**Lines and links.** A channel's line is `metro://xmtp/<account>/<channel id>`. Pass it verbatim as `line`. Its link is `https://stage.box/#/channel/<channel id>`, the last part of the line. Stage shows Markdown, so `[#Launch plan](https://stage.box/#/channel/<channel id>)` is a clickable link. A `message_id` comes from the inbound message or from `read`.

**Channels.**
- Create: `create_group {"station": "xmtp", "name": "Launch plan", "members": ["0x…"]}`. Members are 0x addresses or XMTP inbox ids. It returns the new `line` and `id`.
- Rename: `set_channel_metadata {"line": "…", "name": "New title"}`. No tool sets the description or the picture.
- Add or remove people: `add_members {"line": "…", "members": ["0x…"]}`. `remove_members` takes the same shape.
- Leave: `close_channel {"line": "…", "removeSelf": true}`.
- Read: `group_info {"line": "…"}` gives the name, `labels`, `assigned`, `appData` and the members (`inboxId`, `address`). `list_members {"line": "…"}` gives the members only.
- Direct chat: `dm {"address": "0x…"}` opens a 1:1 chat and returns its line.
- With several XMTP accounts, add `"account": "<id>"` to `create_group` and `dm`.

**Labels and assignees.** They live in the channel's metadata, and Stage shows them on the channel.
- Labels: `set_channel_metadata {"line": "…", "metadata": {"labels": ["🚧 In progress", "Metro"]}}`. At most 16 labels of 24 characters each.
- Assignees: `set_channel_metadata {"line": "…", "metadata": {"assigned": ["0x…"]}}`. Only 0x addresses of current members.
- Each key you send replaces that whole list. Keys you leave out stay as they are. To add one label or one assignee, read `group_info` first and send the old list plus the new one. `[]` clears a list. Read `group_info` again to check it saved.

**Task status labels.** When a channel is a task, keep exactly one of these status labels, plus any project labels:
- `🗒️ Backlog`
- `🎯 To-do`
- `🚧 In progress`
- `🔍 In review`
- `✅ Done`
- `🚫 Blocked`

Move it from Backlog or To-do to In progress, then In review, then Done. Use Blocked while you wait on someone. To change it, read `group_info`, swap the old status for the new one in `labels`, keep the other labels, and send the whole list with `set_channel_metadata` `metadata.labels`.

**Messages.**
- Send: `send {"line": "…", "text": "Hello"}`. Reply with a quote: `reply {"line": "…", "message_id": "…", "text": "…"}`.
- React: `react {"line": "…", "message_id": "…", "emoji": "👍"}`. `unreact` takes the same shape.
- Delete one of your own messages: `delete {"line": "…", "message_id": "…"}`. XMTP has no edit and no typing.
- History: `read {"line": "…", "limit": 20}`.
- Poll: `ask {"line": "…", "question": "Ship today?", "options": ["Yes", "No"]}`.
- File: `create_upload {"name": "report.pdf"}`, run the `curl` line it returns in a shell, then `send {"line": "…", "attachments": [{"upload": "<upload_id>"}]}`. Files that are not images are refused over about 190 KiB.
