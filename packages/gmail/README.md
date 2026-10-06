# Gmail

## Channel discovery

The `listChannels` train action accepts `{ account, query?, limit?, cursor? }`. An explicit account is required. The station declares `discoversChannels: true` and can discover existing threads before receiving a new message.

Discovery calls `users.threads.list` with only thread ids and the next-page token selected. It fetches each new thread with `format=metadata`, `metadataHeaders=Subject`, and a Subject-header-only field mask. A channel's name is the first message's Subject, omitted when empty. Its id is Gmail's thread id and its canonical line is `metro://gmail/<account>/<threadId>`.

No message bodies, snippets, previews, attachments, senders, or recipients are requested or returned. Discovery does not mark mail read, send mail, or use the account-wide `read` action. It does not change OAuth scopes.

- `query` is a case-insensitive literal substring of the thread id, canonical line, or full Subject. It is not Gmail search syntax or body search. Displayed names are capped at 256 Unicode code points after matching.
- Results follow Gmail's mailbox order. Gmail's normal listing excludes Spam and Trash, which the returned capability reason states.
- Each remote page scans at most 100 thread records. Subject requests run in batches of 10 under a shared 45-second request deadline. Already discovered thread ids are not fetched again on later pages.
- A listing stops at 5000 thread records or remote pages, or the shared 2 MiB metadata-state bound. A stopped listing reports `complete: false` with the reason. A query cannot establish that the whole mailbox has no match when the listing is capped.
- `limit` defaults to 50 and accepts integers from 1 to 100. Follow `next_cursor` until absent, including after an empty matching page. Buffered results and cross-page deduplication prevent dropping or repeating threads along a cursor chain.
- Cursors are opaque, bound to the live account instance and normalized query, and expire five minutes after the listing begins. Removing or replacing an account invalidates its cursors, even if its id is reused. At most 32 cursor tickets per account are retained; an expired, evicted, or mismatched cursor requires a new listing. Replaying a fetched cursor does not refetch its provider page.
- `capability.source` is `remote`; `supported` is true even for an empty mailbox. `complete` becomes true only after the provider listing and all buffered results are exhausted without a local cap. Native pagination is not a frozen mailbox snapshot: mailbox changes during a listing follow Gmail's pagination behavior.

Fixture coverage lives in `test/channels.test.ts`; the shared paging contract is tested in `packages/core/test/channel-pages.test.ts`. All provider requests in these tests use injected fake fetch implementations.
