---
name: stage
description: How to use Stage channels (XMTP groups, https://stage.box) through metro. Create a channel, rename it, add or remove members, set labels and assignees, read its info, and send, reply, react, unreact, delete and read messages, and post frames (interactive ChatKit widget views) and wallet cards (payment and signature requests, receipts). Works only when this agent has an XMTP account in metro.
---

Stage (https://stage.box) is a messenger built on XMTP. A Stage channel is an XMTP group. You use it with the metro tools below (`mcp__metro__<name>`).

**XMTP only.** All of this needs an XMTP account connected to this agent in metro. Check with `list_accounts`: it must show an account under `xmtp`. Many agents have none. Then none of this works: say so plainly and do not try another channel. The owner can add an XMTP channel on https://metro.box.

**Lines and links.** A channel's line is `metro://xmtp/<account>/<channel id>`. Pass it verbatim as `line`. Its link is `https://stage.box/#/channel/<channel id>`, the last part of the line. Stage shows Markdown, so `[#Launch plan](https://stage.box/#/channel/<channel id>)` is a clickable link. A `message_id` comes from the inbound message or from `read`.

**Channels.**
- Create: `create_group {"station": "xmtp", "name": "Launch plan", "members": ["0x…"]}`. Members are 0x addresses or XMTP inbox ids. It returns the new `line` and `id`.
- Rename: `set_channel_metadata {"line": "…", "name": "New title"}`. No tool sets the description or the picture.
- Add or remove people: `add_members {"line": "…", "members": ["0x…"]}`. `remove_members` takes the same shape.
- Leave: `close_channel {"line": "…", "removeSelf": true}`.
- Read: `group_info {"line": "…"}` gives the name, `labels`, `assigned`, `category`, `status`, `priority`, `appData` and the members (`inboxId`, `address`). `list_members {"line": "…"}` gives the members only.
- Direct chat: `dm {"address": "0x…"}` opens a 1:1 chat and returns its line.
- With several XMTP accounts, add `"account": "<id>"` to `create_group` and `dm`.

**Labels, assignees, category, status and priority.** They live in the channel's metadata, and Stage shows them on the channel.
- Labels: `set_channel_metadata {"line": "…", "metadata": {"labels": ["Bug"]}}`. At most 16 labels of 24 characters each.
- Assignees: `set_channel_metadata {"line": "…", "metadata": {"assigned": ["0x…"]}}`. Only 0x addresses of current members.
- Category: `set_channel_metadata {"line": "…", "metadata": {"category": "Clients"}}`.
- Status: `set_channel_metadata {"line": "…", "metadata": {"status": "In review"}}`.
- Category and status are each one free-form string per channel. Both are trimmed, whitespace is collapsed, and text is truncated to 24 characters. `""` or `null` clears either field. `group_info` returns them as `category` and `status`.
- Priority: `set_channel_metadata {"line": "…", "metadata": {"priority": "High"}}`. Exactly `Urgent`, `High`, `Medium` or `Low` after trimming surrounding whitespace; empty text or `null` clears it. `group_info` returns it as `priority`.
- Each key you send replaces that whole value. Keys you leave out stay as they are. To add one label or one assignee, read `group_info` first and send the old list plus the new one. `[]` clears a list. Read `group_info` again to check it saved.

**Task status labels.** Keep the owner's existing workflow. For a label-based task workflow, keep exactly one of these status labels, plus any project labels:
- `🗒️ Backlog`
- `🎯 To-do`
- `🚧 In progress`
- `🔍 In review`
- `✅ Done`
- `🚫 Blocked`

Move it from Backlog or To-do to In progress, then In review, then Done. Use Blocked while you wait on someone. To change it, read `group_info`, swap the old status for the new one in `labels`, keep the other labels, and send the whole list with `set_channel_metadata` `metadata.labels`.

The separate `metadata.status` and `metadata.priority` fields are optional. Status is free-form, not limited to the label names above. Do not migrate or remove existing labels unless asked.

**Messages.**
- Send: `send {"line": "…", "text": "Hello"}`. Reply with a quote: `reply {"line": "…", "message_id": "…", "text": "…"}`.
- React: `react {"line": "…", "message_id": "…", "emoji": "👍"}`. `unreact` takes the same shape.
- Delete one of your own messages: `delete {"line": "…", "message_id": "…"}`. XMTP has no edit and no typing.
- History: `read {"line": "…", "limit": 20}`.
- Poll: `ask {"line": "…", "question": "Ship today?", "options": ["Yes", "No"]}`.
- Poll votes are numeric reactions with zero-based indexes: `0` is the first option, `1` is the second, and so on, in the poll's stored option order. For the poll above, `0` means Yes and `1` means No. Never use a one-based guess. Match the inbound reaction's `target_id` to the poll's `messageId` returned by `ask`, not its `pollId` or the reaction's own `message_id`.
- With several questions, the first question still uses bare option indexes (`0`, `1`, …); later questions use `q:o`, with both indexes zero-based. `1:0` means the first option of the second question. Explicit `0:0` also means the first option of the first question.
- Keep the poll's questions, options and `messageId`: `read` shows `[poll]` and `[reaction]`, not their choices or vote values. If the original mapping is unavailable, do not guess.
- File: `create_upload {"name": "report.pdf"}`, run the `curl` line it returns in a shell, then `send {"line": "…", "attachments": [{"upload": "<upload_id>"}]}`. Files that are not images are refused over about 190 KiB.

**Frames.** A frame is a small interactive view: a report, a choice, a form. Stage shows the frame itself in the chat (its `start` screen when it has screens), at image size, at most 400 x 400, clipped with a fade when taller. A tap opens it full screen. Its buttons do nothing in the chat: they work in the full view.
- Send: `send {"line": "…", "frame": {"title": "Deploy", "description": "Version 2.4 is ready", "widget": {…}}}`. A frame goes with `send`, like a file: there is no separate tool. `title` and `description` are optional: they come from the first `Title` and text in the widget when missing. With `text` as well, the text goes first, and the `message_id` you get back is the frame's.
- `widget` is OpenAI ChatKit widget JSON, with ChatKit's names and props (https://openai.github.io/chatkit-js/): a `Card`, `ListView` or `Basic` root, with `Row`, `Col`, `Box`, `Text`, `Title`, `Caption`, `Markdown`, `Badge`, `Icon`, `Image`, `Button`, `Divider`, `Spacer`, `Form`, `Input`, `Textarea`, `Select`, `DatePicker`, `Checkbox`, `RadioGroup` and `Table`. Images must be `https://`. Number spacing is in steps of 4px. At most 64K characters, 16 levels deep and 500 nodes. Stage shows a small notice for anything it does not know.
- Example, the arguments of one `send`:
  ```json
  {"line": "…", "frame": {"widget": {"type": "Card", "children": [
    {"type": "Title", "value": "Deploy version 2.4?"},
    {"type": "Text", "value": "3 fixes, no migration.", "color": "secondary"},
    {"type": "Input", "name": "note", "placeholder": "Note (optional)"},
    {"type": "Row", "children": [
      {"type": "Button", "label": "Deploy", "onClickAction": {"type": "deploy", "payload": {"version": "2.4"}}},
      {"type": "Button", "label": "Not now", "color": "secondary", "onClickAction": {"type": "deploy.cancel"}}
    ]}
  ]}}}
  ```
- A tap comes back to you as a reply to the frame: `Frame action: deploy {"version":"2.4","note":"…"} (tapped "Deploy")`. The values of the fields (`Input`, `Select`, `Checkbox`, …) are added to the payload by their `name`. `Button.onClickAction`, `ListViewItem.onClickAction`, a `Card` `confirm`/`cancel` (`{"label", "action"}`) and a `Form` `onSubmitAction` send one. Answer it like any message.
- Screens: send `screens` instead of `widget` to put several screens in one frame, e.g. a list and a page per item. Each screen is a widget, or `{"title", "widget"}` for its own title in Stage's top bar. `start` names the first screen and is required. The action `{"type": "frame.open", "payload": {"screen": "<id>"}}` opens a screen and `{"type": "frame.back"}` goes back. They stay in Stage: no message comes to you. Stage's back arrow goes to the previous screen, and to the chat from the first one. Every other action comes to you as usual, with `screen` (the screen it was tapped on) in its payload. At most 50 screens and 64K characters for all of them; `start` and every `frame.open` must name a screen. Example:
  ```json
  {"line": "…", "frame": {"title": "Open invoices", "start": "home", "screens": {
    "home": {"type": "ListView", "children": [
      {"type": "ListViewItem", "onClickAction": {"type": "frame.open", "payload": {"screen": "inv-1"}},
        "children": [{"type": "Text", "value": "Acme, CHF 420"}]}
    ]},
    "inv-1": {"title": "Acme", "widget": {"type": "Card", "children": [
      {"type": "Title", "value": "Invoice 1040, CHF 420"},
      {"type": "Row", "children": [
        {"type": "Button", "label": "Back", "color": "secondary", "onClickAction": {"type": "frame.back"}},
        {"type": "Button", "label": "Pay", "onClickAction": {"type": "invoice.pay", "payload": {"id": 1040}}}
      ]}
    ]}}
  }}}
  ```
- Live frames: add `"source": {"url": "https://…"}` to the frame to name the node that serves its widget, an https URL that answers with ChatKit widget JSON (Stage's node protocol: https://github.com/bonustrack/stage/blob/main/NODES.md). Stage then sends the frame's actions to that node, not to you. The node's reply replaces the frame in place, on that person's device only, and no message comes to you. Only an action with ChatKit's `"handler": "client"` still comes to you as a frame action, like every action of a frame without `source`. `frame.open` and `frame.back` stay in Stage. Here `24h` goes to the node, and `Ask` comes to you as `Frame action: ask (tapped "Ask")`:
  ```json
  {"line": "…", "frame": {"source": {"url": "https://eth.example.com/"}, "widget": {"type": "Card", "children": [
    {"type": "Title", "value": "ETH 2,410 USD"},
    {"type": "Row", "children": [
      {"type": "Button", "label": "24h", "onClickAction": {"type": "range", "payload": {"days": 1}}},
      {"type": "Button", "label": "Ask", "color": "secondary", "onClickAction": {"type": "ask", "handler": "client"}}
    ]}
  ]}}}
  ```
  Stage calls the node only on a tap or on Refresh in the frame's three-dot menu, and only once the person has accepted the chat. Until then, and again after the app restarts, it shows the widget as you sent it. Do not add a Refresh button to a node: every live frame and Dashboard widget has Refresh in its menu. Add to dashboard on the frame adds a live widget loaded from that URL, and its `"handler": "client"` actions still come to this chat.

**Wallet cards.** The payment and signature cards Stage's own Request payment and Request signature send. Sending one moves nothing and signs nothing: the person taps Pay or Sign and confirms in Stage. Send one only when you were asked to.
- Send: `send {"line": "…", "wallet": {"type": "<type>", "content": {…}}}`. With `text` or a `frame` as well, the card goes last, and the `message_id` you get back is the card's.
- Payment request, `walletSendCalls`, a card with a Pay button. Stage pays a request with one call; a Stage wallet pays on Base only.
  ```json
  {"type": "walletSendCalls", "content": {"version": "1.0", "chainId": "0x2105", "from": "0x<your address>", "calls": [
    {"to": "0x<who gets paid>", "value": "0x38d7ea4c68000", "metadata": {"description": "Dinner", "transactionType": "transfer",
      "currency": "ETH", "amount": 0.001, "decimals": 18, "toAddress": "0x<who gets paid>"}}
  ]}}
  ```
  `chainId` is a hex string (`0x2105` is Base) and `value` is in wei, hex. For a token, `to` is the token contract, `data` its `transfer(address,uint256)` call data, `value` is left out, and `metadata` has `currency`, `amount` and `toAddress` (who gets paid).
- Receipt, `transactionReference`: `{"networkId": 8453, "reference": "0x<tx hash>", "metadata": {"currency": "USDC", "amount": 5}}`. Stage shows "Payment sent · 5 USDC" (or "Transaction sent" without an amount) and a link to the explorer. Only post a real transaction hash.
- Signature request, `signatureRequest`, a card with a Sign button: `{"id": "<any id>", "kind": "personal", "message": "The text to sign", "description": "Why"}`, or `"kind": "eip712"` with `"eip712": {"domain", "types", "primaryType", "message"}` instead of `message`.
- Signature, `signatureReference`: `{"requestId": "<message_id of the request>", "signature": "0x…", "signer": "0x…"}`. Stage shows it as Signed.
