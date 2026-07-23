# @metro-labs/line

Metro station for the **LINE Messaging API** (a LINE Official Account / bot).

- **Outbound**: text via the LINE push API (`POST https://api.line.me/v2/bot/message/push`,
  `Authorization: Bearer <channelAccessToken>`, body `{ to, messages: [{ type: 'text', text }] }`).
  Handled by an out-of-process train (subprocess) like the other stations.
- **Inbound**: a webhook route on metro's existing HTTP server — `POST /line/webhook`
  (or `POST /line/webhook/<account>` for multi-account). The `X-Line-Signature` header is
  verified as base64(HMAC-SHA256(rawBody, channelSecret)); a mismatch is rejected (401) with
  no fallback. Text message events are emitted as metro inbound events; media/stickers surface a
  placeholder (`[image]`, `[sticker]`, …) — never a blank message. Always replies `200` quickly.

## Line scheme

```
metro://line/<account>/<sourceId>
```

`sourceId` is the LINE user id (`U…`), group id (`C…`), or room id (`R…`). A single-account
deployment can use the bare `metro://line/<sourceId>` form (account defaults to the sole account).

## Config (house convention — secrets live in `accounts.config` jsonb)

```json
{ "channelAccessToken": "<long-lived channel access token>", "channelSecret": "<channel secret>" }
```

`materialize.ts` spreads `config` into `~/.metro/line-accounts.json`; the train reads
`channelAccessToken` for push, and the in-core webhook route reads `channelSecret` to verify
signatures. No new DB columns — same pattern as every other station.

## Supported verbs

| Verb | Supported | Notes |
|---|---|---|
| `send` | ✅ | LINE push API |
| `reply` | ✅ | mapped to a push to the same source (the LINE reply token is ephemeral/per-webhook, not available to an outbound tool call) |
| `edit` / `delete` / `react` / `unreact` / `read` | ❌ | the LINE Messaging API does not support them — returns the standard "unsupported on this station" reason |

## Provisioning

1. In the [LINE Developers Console](https://developers.line.biz/console/): create a **provider**,
   then a **Messaging API channel** under it.
2. On the channel's **Messaging API** tab: issue a **long-lived channel access token**; copy the
   **channel secret** from the **Basic settings** tab.
3. Turn **off** "Auto-reply messages" and "Greeting messages" (LINE Official Account Manager →
   Response settings) so the bot doesn't auto-respond.
4. Set the **Webhook URL** to `https://<METRO_PUBLIC_URL>/line/webhook` and enable **Use webhook**.
5. Insert the DB accounts row:

```sql
INSERT INTO accounts (agent_id, station, account_id, config)
VALUES (
  <agent_id>, 'line', '<account_id>',
  '{"channelAccessToken":"<token>","channelSecret":"<secret>"}'::jsonb
);
```

The train is dormant until a `line` account exists in the DB.
