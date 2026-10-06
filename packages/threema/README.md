# @metro-labs/threema

> The Metro **threema** station: a Threema Gateway ID in end-to-end mode, so an agent
> can be written to on Threema and answer there.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/core` plus `tweetnacl` for the NaCl box every Threema message is sealed in.

- `.` → `station.ts` (`threemaStation`: accounts, a train, messaging and channel discovery).
- `./train` → `index.ts`, the subprocess. It answers `accounts`, `listChannels`, `send` and `callback`, among other actions.
- `./verify` → `verify.ts`, what the daemon runs at attach time: it checks the Gateway ID and
  API secret against `/credits`, and that the pasted private key is the one the Gateway holds
  the public half of. It uses `node:crypto` only, so the daemon never loads the SDK.

Inbound messages reach the daemon on the callback URL minted at attach time
(`/api/threema/<callback id>/<token>`, public through the Funnel); the daemon forwards the
encrypted box to the train, which checks the MAC with the API secret, decrypts it with the
private key, and emits the message on `metro://threema/<account>/<THREEMA ID>`. Outbound goes
through `send_e2e`; a `reply` is a Threema quote (`> quote #<message id>`). Thumbs-up and
thumbs-down delivery receipts arrive as reactions. The station also carries group messages,
emoji reactions and files. Edits, deletes and creating groups are not implemented.

## Channel discovery

`listChannels` requires an explicit `account`. The shared directory handles case-insensitive
`query` matching against IDs, names and canonical lines, plus `limit` and `cursor` paging.
It lists every locally stored group roster, even with no recent message, and observed direct
chats. Group lines are `metro://threema/<account>/<CREATOR>-<groupIdHex16>`; direct lines use
an uppercase Threema ID. Names come from group renames and direct senders' nicknames.

The capability is always `supported: true`, `source: local`, `complete: false`: Threema
Gateway has no remote conversation-list or history endpoint. An empty local directory is
not proof that the account has no conversations. Unknown groups without a stored roster
and direct chats not observed since this feature was installed are not listed. Discovery
makes no Gateway call, sends no roster request, fetches no media and emits no messages.

Direct metadata is bounded to 5,000 IDs with names of at most 256 characters, recorded only
from authenticated, decrypted direct text/file/reaction/receipt callbacks and successful
direct sends. Public-key lookups and group participants are not conversations. The directory
retains no message bodies, message IDs, timestamps, media, keys or replay history. Shared directory
size limits can further truncate the combined group/direct listing and report it as partial.

Direct metadata survives restarts in `threema-chats-<account>.json` (0600), beside the existing
group roster files under `THREEMA_GROUPS_DIR` or `~/.metro`. Both files are account-scoped and
removed by `forget`/`forgetExcept`. A self-leave removes the group from fresh listings;
already issued cursors remain snapshots until expiry. Metadata write failures are logged
without failing an otherwise accepted inbound message or successful send.
