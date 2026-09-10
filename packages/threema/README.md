# @metro-labs/threema

> The Metro **threema** station: a Threema Gateway ID in end-to-end mode, so an agent
> can be written to on Threema and answer there.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/core` plus `tweetnacl` for the NaCl box every Threema message is sealed in.

- `.` → `station.ts` (`threemaStation`: accounts, a train, `send` and `reply`, no attachments).
- `./train` → `index.ts`, the subprocess. It answers `accounts`, `send` and `callback`.
- `./verify` → `verify.ts`, what the daemon runs at attach time: it checks the Gateway ID and
  API secret against `/credits`, and that the pasted private key is the one the Gateway holds
  the public half of. It uses `node:crypto` only, so the daemon never loads the SDK.

Inbound messages reach the daemon on the callback URL minted at attach time
(`/api/threema/<callback id>/<token>`, public through the Funnel); the daemon forwards the
encrypted box to the train, which checks the MAC with the API secret, decrypts it with the
private key, and emits the message on `metro://threema/<account>/<THREEMA ID>`. Outbound goes
through `send_e2e`; a `reply` is a Threema quote (`> quote #<message id>`). Thumbs-up and
thumbs-down delivery receipts arrive as reactions. Reactions, edits, deletes, files and groups
are not carried: the Gateway protocol has none of the first three, and the last two are not
built.
