# Outlook

## Channel discovery

The `listChannels` train action accepts `{ account, query?, limit?, cursor? }`. An explicit account is required. The station declares `discoversChannels: true` and can discover existing conversations before receiving a new message.

Discovery uses Microsoft Graph `/me/messages` with `$select=conversationId,subject`, newest first. It deduplicates by conversation id across pages. A channel's name is the newest encountered message's Subject, omitted when empty. Its id is Graph's conversation id and its canonical line is `metro://outlook/<account>/<conversationId>`, with the existing mail-line escaping for `/`, `+`, and `%`.

No message bodies, previews, attachments, senders, or recipients are requested or returned. Discovery never marks mail read, sends mail, or calls the account-wide `read` action. It does not change OAuth scopes.

- `query` is a case-insensitive literal substring of the conversation id, canonical line, or full first-encountered Subject. It is not Graph search syntax or body search. Displayed names are capped at 256 Unicode code points after matching.
- Each remote request scans at most 100 message metadata records with a 45-second request deadline. Several messages may represent one conversation, so the scan cap is not a count of unique conversations.
- A listing stops at 5000 message records or remote pages, or the shared 2 MiB metadata-state bound. A stopped listing reports `complete: false` with the reason. A capped search does not cover the whole mailbox.
- `limit` defaults to 50 and accepts integers from 1 to 100. Follow `next_cursor` until absent, even when the current page has no matches. Buffered results and cross-page deduplication prevent dropping or repeating conversations along a cursor chain.
- Cursors are opaque, bound to the live account instance and normalized query, and expire five minutes after the listing begins. Removing or replacing an account invalidates its cursors, even if its id is reused. At most 32 cursor tickets per account are retained. Expired, evicted, or mismatched cursors are rejected before a provider request. Replaying a fetched cursor does not refetch its provider page.
- Graph next-page links must stay on the configured Graph origin and `/me/messages` path, with only metadata-safe paging parameters. The metadata selection and ordering are pinned; credentials, fragments, body selections, expanded attachments, and other endpoints are rejected. Discovery requests do not follow redirects.
- `capability.source` is `remote`; `supported` is true even for an empty mailbox. `complete` becomes true only after the provider listing and all buffered results are exhausted without a local cap. Native pagination is not a frozen mailbox snapshot: mailbox changes during a listing follow Graph's pagination behavior.

Fixture coverage lives in `test/channels.test.ts`; the shared paging contract is tested in `packages/core/test/channel-pages.test.ts`. All provider requests in these tests use injected fake fetch implementations.
