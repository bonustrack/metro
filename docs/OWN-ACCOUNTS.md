# Metro's own accounts

Decided by the owner on 2026-11-16. Metro keeps its own users, organizations, members and sessions, and signs people in with Google and Microsoft itself. api.metro.box has run this way since 2026-11-16 at 18:47 UTC. WorkOS was removed from the code on 2026-11-17 (step 4). One small step is left: the schema cleanup (step 5).

## Why

- Metro used to sign people in through WorkOS. WorkOS's Microsoft sign-in only takes personal Microsoft accounts: it always uses the `/consumers` authority. A Microsoft 365 work account (anderra.ch, mcigroup.ch) could not use the Microsoft button, so it needed an email code (2026-09-26, see `docs/HISTORY.md`).
- Since Metro calls Google and Microsoft itself, a work account signs in with the Microsoft button.
- One vendor less sits in the sign-in path. Metro keeps its own users, members and sessions.
- Piston.box already did this. Its code was the model: `stagelabs/dashboard`, `apps/mcp/src/providers.ts`, `oauth.ts` and `jwt-verify.ts`.

## Decisions

- Sign in with Google and Microsoft only. Metro calls them directly.
- No email code, no GitHub, no login link (the operator's login links were removed on 2026-11-17, owner's call). Someone who can sign in with neither Google nor Microsoft cannot use Metro.
- An admin adds a member by email address. No invitation email is sent. The person signs in with that address and is in the organization.
- api.metro.box makes the tokens. Every box checks them offline, with no call to api.metro.box per request.
- User ids keep the shape they always had, `user_` and a 26 character ULID, so every id stored before keeps working. Organization ids keep their `org_` ids.

## The token contract

- A JWT signed with RS256. The header has `alg: RS256` (nothing else is accepted), `typ: JWT`, and `kid`: the RFC 7638 thumbprint of the public key, in base64url.
- Claims:
  - `iss`: exactly `https://api.metro.box`.
  - `sub`: the user id (`user_` and 26 characters).
  - `sid`: the session id.
  - `org_id` and `role` (`admin` or `member`): both are absent when the user has no organization.
  - `iat` and `exp`. `exp` is `iat` plus 10 minutes.
- The page reads only `sub`, `sid`, `org_id`, `role` and `exp` (`packages/client/src/auth/account.ts`).
- The public keys are at `https://api.metro.box/.well-known/jwks.json`: open, with CORS, `cache-control: max-age=300`.
- The signing key is the Fly secret `METRO_AUTH_SIGNING_KEY`: an RSA private key of 2048 bits, in PKCS8 PEM. Make one with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.
- `METRO_AUTH_NEXT_SIGNING_KEY` is optional. It is published and accepted, but it never signs.
- With no key set, the api publishes an empty key set and says so once in its boot log.

How a token is checked (`packages/http/src/user-token.ts`, the same code on api.metro.box and on every box):

- Only Metro's issuer, exactly `https://api.metro.box`. A token of any other issuer, an old WorkOS one included, is refused. No key is ever fetched from a url found in the token.
- RS256, a `kid` and `typ: JWT` are required, with `iat`. A token may live one hour at most (`exp - iat`), and its `iat` may be five minutes ahead of the clock at most.
- The key set url is fixed. `METRO_AUTH_BASE` moves it, for tests and the compat check only.
- api.metro.box checks against its own keys, in memory, with no network (`apps/api/src/auth/signing-keys.ts`).
- A box keeps the set in `<agents dir>/.jwks-metro` (0600). It fetches the set at boot, best effort and never fatal, again on an unknown `kid`, and when the set is older than an hour, once a minute at most. A failed fetch, or an empty answer, keeps the old set.
- The rule on a box: the token's `org_id` must equal `.owner`, else 403.

## The steps

1. **Boxes and api.metro.box accept Metro tokens** (built, every box on beta.337 or later): the token check above, next to WorkOS's.
2. **The tables and the WorkOS export** (built): users, their sign-in identities, organization members, sessions (migrations `0028`, `0029`, `0030`). The export copied the users, organizations, memberships, pending invitations and Google and Microsoft sign-ins from WorkOS with their ids, once, before the switch.
3. **The switch** (done on 2026-11-16 at 18:47 UTC): `METRO_ACCOUNTS=metro` on Fly. api.metro.box signed people in itself from then on, and moved an old WorkOS session to a Metro session at its next refresh.
4. **Cleanup** (done on 2026-11-17): WorkOS left the code entirely. Removed: the `METRO_ACCOUNTS` switch and the `workos` mode, WorkOS sign-in, the email code, GitHub, WorkOS invitations, the WorkOS session revoke, the exchange of an old WorkOS refresh token (a refresh token without `mrt_` is now refused like any unknown token: the page signs out, and the person signs in again with Google or Microsoft), the WorkOS export and `docs/WORKOS-EXPORT.md`, the login links, and the WorkOS token check. `workos-token.ts` became `user-token.ts`. A box checks only Metro tokens and removes the old WorkOS key cache `<agents dir>/.jwks` at boot. A box on an older version keeps accepting WorkOS tokens until it updates, which changes nothing, since nobody makes WorkOS tokens any more.
5. **Schema cleanup** (2026-11-17, two deploys, since the column drop rule in CLAUDE.md, Database, applies): `0032` drops the `login_links` table (never used: no link was ever made) and tightens the `auth_sessions.method` check to `google`, `microsoft` and `workos`, while the code stops naming `auth_sessions.link`; `0033`, one deploy later, drops that column. `0035`, the same day, deletes the sessions moved over from WorkOS during step 3 (method `workos`) and limits the check to `google` and `microsoft` (Less's call: no WorkOS trace left). Each person on such a session was signed out once at their next refresh and signed in again with Google or Microsoft.

After step 4 merges, the owner:

1. Unsets the WorkOS secrets on Fly: `fly secrets unset -a metro WORKOS_API_KEY WORKOS_CLIENT_ID METRO_ACCOUNTS`.
2. Closes the WorkOS account.

## Rotating the signing key

1. Make a new key and set it as `METRO_AUTH_NEXT_SIGNING_KEY`. It is published at once. Boxes learn it on their next fetch, within an hour.
2. Then set the new key as `METRO_AUTH_SIGNING_KEY` and the old one as `METRO_AUTH_NEXT_SIGNING_KEY`. Tokens signed with the old key still work for their last 10 minutes.
3. After 10 minutes, remove `METRO_AUTH_NEXT_SIGNING_KEY`. Boxes drop the old key within an hour. A box that sees an unknown `kid` fetches the set again by itself.

## Risks

- **The signing key** signs tokens for every organization. It lives only in Fly secrets, never in the repo, a log or the database. A leak means a rotation, and every box drops the old key within an hour.
- **api.metro.box down**: boxes keep checking tokens with their cached set. New sign-ins and refreshes fail.
- **A box clock** more than five minutes behind refuses Metro tokens, because their `iat` looks like the future. A clock more than a minute ahead sees them expire early. Boxes run NTP; agent signatures already refuse a clock five minutes off.
- **Microsoft email proof**: `upn` and `preferred_username` are not proof. Trusting them would let any tenant admin take an account by its address. Only `xms_edov: true` proves the email, or a personal account (the consumer tenant) on Microsoft's own mail domains, where the address is the account itself.
- **Google email proof**: `email_verified` only says Google checked the address once. A Google account made with a company address before that company moved its mail elsewhere still says verified, so only Gmail addresses and the Workspace domain in `hd` prove an email, and a proven email never adds a sign-in to someone who already has one.
- **A stolen refresh token**: rotation and reuse detection end the session the first time both the thief and the owner use it, however many rotations apart.
- **No fallback sign-in**: with the login links gone, a person whose Google or Microsoft account is lost, or whose email neither provider proves, cannot sign in until an admin adds an address they can prove.
