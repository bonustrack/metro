# Metro's own accounts: leaving WorkOS

The plan, decided by the owner on 2026-11-16. Step 1 is built. The other steps are not built yet.

## Why

- Metro signs people in through WorkOS today. WorkOS's Microsoft sign-in only takes personal Microsoft accounts: it always uses the `/consumers` authority. A Microsoft 365 work account (anderra.ch, mcigroup.ch) cannot use the Microsoft button, so it needs the email code (2026-09-26, see `docs/HISTORY.md`).
- If Metro calls Google and Microsoft itself, a work account signs in with the Microsoft button.
- One vendor less sits in the sign-in path. Metro keeps its own users, members and sessions.
- Piston.box already does this. Its code is the model: `stagelabs/dashboard`, `apps/mcp/src/providers.ts`, `oauth.ts` and `jwt-verify.ts`.

## Decisions

- Sign in with Google and Microsoft only. Metro calls them directly.
- No email code and no GitHub.
- An admin adds a member by email address. No invitation email is sent. The person signs in with that address and is in the organization.
- The fallback is a login link the operator makes, for someone who cannot sign in otherwise.
- api.metro.box makes the tokens. Every box keeps checking them offline, with no call to api.metro.box per request.
- User ids keep the WorkOS shape, `user_` and a 26 character ULID, so every id stored today keeps working. Organization ids keep their `org_` ids.

## The token contract

Both step 1 and step 3 use exactly this.

- A JWT signed with RS256. The header has `alg: RS256` (nothing else is accepted), `typ: JWT`, and `kid`: the RFC 7638 thumbprint of the public key, in base64url.
- Claims:
  - `iss`: exactly `https://api.metro.box`.
  - `sub`: the user id (`user_` and 26 characters).
  - `sid`: the session id.
  - `org_id` and `role` (`admin` or `member`): both are absent when the user has no organization.
  - `iat` and `exp`. `exp` is `iat` plus 10 minutes.
- The page reads only `sub`, `sid`, `org_id`, `role` and `exp` (`packages/client/src/auth/account.ts`). It needs no change.
- The public keys are at `https://api.metro.box/.well-known/jwks.json`: open, with CORS, `cache-control: max-age=300`.
- The signing key is the Fly secret `METRO_AUTH_SIGNING_KEY`: an RSA private key of 2048 bits, in PKCS8 PEM. Make one with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.
- `METRO_AUTH_NEXT_SIGNING_KEY` is optional. It is published and accepted, but it never signs.
- With no key set, the api publishes an empty key set and says so once in its boot log.

## The steps

### Step 1: boxes and api.metro.box accept both issuers (built)

Nothing makes Metro tokens yet, so nobody sees a change.

- `packages/http/src/workos-token.ts` checks a token from either issuer. The token's unverified `iss` picks the key set: WorkOS (`https://api.workos.com` or a path below it) or Metro (exactly `https://api.metro.box`). The signature is then checked only against that set. No key is ever fetched from a url found in the token.
- RS256 and a `kid` are always required. A Metro token also needs `typ: JWT` and `iat`. It may live one hour at most (`exp - iat`), and its `iat` may be five minutes ahead of the box's clock at most.
- The Metro key set url is fixed. `METRO_AUTH_BASE` moves it, for tests and the compat check only, like `WORKOS_API_BASE`.
- A box keeps the Metro set in `<agents dir>/.jwks-metro` (0600, beside the WorkOS `.jwks`). It fetches the set at boot, best effort and never fatal. It fetches it again on an unknown `kid`, and when the set is older than an hour. A refetch happens once a minute at most. A failed fetch, or an empty answer, keeps the old set.
- The rule on a box does not change: the token's `org_id` must equal `.owner`, else 403.
- api.metro.box checks Metro tokens on every bearer route against its own keys, in memory, with no network (`apps/api/src/auth/signing-keys.ts`). It serves `/.well-known/jwks.json`. `mintAccessToken` exists for tests; nothing in production calls it yet.

How a box answers each kind of token:

| Token | A box on the step 1 beta or later | An older box |
| --- | --- | --- |
| WorkOS, from the owner organization | Accepted, as before | Accepted |
| Metro, from the owner organization | Accepted | 401 |
| Either kind, another organization or none | 403 | 403 for WorkOS, 401 for Metro |
| Metro, signed by a key not in the Metro set, or living over an hour | 401 | 401 |

### Step 2: the tables and the WorkOS export

- New tables in api.metro.box's Postgres (migration `0028`): users, their sign-in identities, organization members and sessions.
- A script exports the users, organizations and memberships from WorkOS with their existing ids.
- Nothing reads the tables yet.

### Step 3: the switch

- api.metro.box makes the tokens, with the contract above.
- The `/api/auth/*` and `/api/organization…` routes (refresh, switch, logout, organizations, members) move off WorkOS. Until then they still call WorkOS with the token's user and session ids, even for a Metro token.
- Sessions use rotating refresh tokens, `mrt_` and random bytes. Only their SHA-256 is stored.
- A session ends after 30 days without use, and after 90 days in any case.
- Each refresh gives a new refresh token. The previous one is still accepted for 60 seconds, so two tabs refreshing at the same time both work. A refresh token used again after that revokes the whole session, since it was probably stolen.
- Google sign-in requires `email_verified: true`.
- Microsoft sign-in uses the `/common` authority, so work and personal accounts both work. The identity is `tid:oid` (the tenant and the object id). The email counts as proven only when the token says `xms_edov: true` (an optional claim to turn on in the Entra app). Metro never falls back to `preferred_username` or `upn`: anyone who runs a tenant can put any address there.
- An admin adds a member by email address. The person signs in with a proven address and joins.
- The operator can make a login link as the fallback.
- The old WorkOS refresh tokens are exchanged once for a Metro session, so nobody has to sign in again. A token that cannot be exchanged means one new sign-in.

### Step 4: cleanup

- Remove WorkOS: `apps/api/src/auth/workos.ts`, the email code, the invitations, the `WORKOS_*` secrets, the WorkOS key set and `.jwks` on boxes.
- Rename `workos-token.ts` to a name without WorkOS in it.
- Only after every old WorkOS refresh token had its chance to be exchanged, and every box runs a version that no longer needs WorkOS.

## The order

1. Ship step 1 in a beta. Set `METRO_AUTH_SIGNING_KEY` on Fly during step 1, so every box fetches and caches the Metro key set early.
2. Step 2 can ship at any time. It changes nothing people see.
3. **Every box must run the step 1 beta before the switch.** An older box answers 401 to every Metro token, so the page could not manage it any more. Check each box's version first: its `/health` and `/api/mode` answer it.
4. The switch (step 3).
5. Cleanup (step 4), weeks later.

## Rotating the signing key

1. Make a new key and set it as `METRO_AUTH_NEXT_SIGNING_KEY`. It is published at once. Boxes learn it on their next fetch, within an hour.
2. Then set the new key as `METRO_AUTH_SIGNING_KEY` and the old one as `METRO_AUTH_NEXT_SIGNING_KEY`. Tokens signed with the old key still work for their last 10 minutes.
3. After 10 minutes, remove `METRO_AUTH_NEXT_SIGNING_KEY`. Boxes drop the old key within an hour. A box that sees an unknown `kid` fetches the set again by itself.

## Risks

- **A box left on an old version** at the switch cannot be managed from the page until it updates. Check every box first (see The order).
- **The signing key** signs tokens for every organization. It lives only in Fly secrets, never in the repo, a log or the database. A leak means a rotation, and every box drops the old key within an hour.
- **api.metro.box down**: boxes keep checking tokens with their cached set. New sign-ins and refreshes fail, as they do today when WorkOS is down.
- **A box clock** more than five minutes behind refuses Metro tokens, because their `iat` looks like the future. A clock more than a minute ahead sees them expire early. Boxes run NTP; agent signatures already refuse a clock five minutes off.
- **Microsoft email proof**: `upn` and `preferred_username` are not proof. Trusting them would let any tenant admin take an account by its address. Only `xms_edov: true` proves the email.
- **A stolen refresh token**: rotation and reuse detection end the session the first time both the thief and the owner use it.
- **The WorkOS exchange** needs WorkOS still set up during step 3. Cleanup waits for it.
