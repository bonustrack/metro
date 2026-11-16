# Metro's own accounts: leaving WorkOS

The plan, decided by the owner on 2026-11-16. Steps 1 to 3 are built. Step 3 waits behind the Fly env `METRO_ACCOUNTS`, which stays `workos` until the owner flips it (see The flip). Step 4 is not built.

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
- api.metro.box checks Metro tokens on every bearer route against its own keys, in memory, with no network (`apps/api/src/auth/signing-keys.ts`). It serves `/.well-known/jwks.json`. `mintAccessToken` signs them; only `metro` mode (step 3) calls it for a sign-in.

How a box answers each kind of token:

| Token | A box on the step 1 beta or later | An older box |
| --- | --- | --- |
| WorkOS, from the owner organization | Accepted, as before | Accepted |
| Metro, from the owner organization | Accepted | 401 |
| Either kind, another organization or none | 403 | 403 for WorkOS, 401 for Metro |
| Metro, signed by a key not in the Metro set, or living over an hour | 401 | 401 |

### Step 2: the tables and the WorkOS export (built)

- New tables in api.metro.box's Postgres (migration `0028`): users, their sign-in identities, organization members, sessions and login links. `0029` lets a session's `method` be `workos` too (a session moved over from WorkOS).
- `apps/api/scripts/workos-sync.ts` copies the users, organizations, memberships, pending invitations and Google and Microsoft sign-ins from WorkOS with their existing ids (`docs/WORKOS-EXPORT.md`). With `METRO_ACCOUNTS=metro` it refuses `--apply`: Metro is the source then, and an apply would undo what changed since.

### Step 3: the switch (built, off until the flip)

One Fly env picks who keeps the accounts: `METRO_ACCOUNTS` is `workos` (the default, and any value but `metro`) or `metro`. The boot log says which, once. Merging changes nothing.

**What stays the same in both modes**: every route and answer shape the page uses (`/api/auth/login`, `/callback` with the handoff in `#/auth/<handoff>`, `/exchange`, `/refresh`, `/switch`, `/organization`, `/organizations`, `/logout`, `/account`, `/api/organization…`), the phone sign-in (`metro://auth` with PKCE), and the admission rules (waitlist, approved, operator, a member of an organization).

**`workos` mode** is today's api, plus three things: `GET /api/mode` answers `accounts: 'workos'` and `providers: ['google', 'microsoft', 'github']`; a Metro refresh token (`mrt_`) is still rotated, checked against WorkOS's memberships, so switching back keeps Metro sessions alive; the operator is also `OPERATOR_USER_ID`.

**`metro` mode**:

- **Sign-in**: api.metro.box runs OAuth with Google and Microsoft itself (`auth/providers.ts`, `auth/oauth.ts`, `auth/id-token.ts`, adapted from Piston's): authorization code with PKCE S256 and a nonce, both kept in the state map of `auth/routes.ts`, which also says which provider the callback belongs to. The id_token is checked RS256 against the provider's key set (fetched again on an unknown `kid` or after an hour), with `aud`, `iss`, `nonce`, `exp` and `nbf`. One redirect URI for both: `https://api.metro.box/api/auth/callback`. No GitHub (`provider=github` is a 400) and no email code (`/api/auth/email/*` is a 404).
- **Google**: scopes `openid email profile`, `prompt=select_account`, issuer `https://accounts.google.com` or `accounts.google.com`, `email_verified` must be true on every sign-in. The identity is `(google, sub)`.
- **Microsoft**: the `/common` authority, scopes `openid email profile`, `prompt=select_account`, `response_mode=query`. The issuer must be exactly `https://login.microsoftonline.com/<tid>/v2.0`. The identity is `(microsoft, '<tid>:<oid>')`. The email is proven only when `xms_edov` is true, or when `tid` is the consumer tenant `9188040d-6c67-4c5b-b112-36a304b66dad` and the address is on Microsoft's own domains (outlook, hotmail and live with `.com` or a country ending, and `msn.com`; `microsoftOwnDomain`). Metro never reads `preferred_username` or `upn`.
- **Linking** (`linkIdentity` in `db/identities.ts`): a known identity signs its person in, whatever its email says now. A new identity needs a proven email: it is linked to the person with that email (a member added by email who never signed in is claimed this way), or makes a new person. Two people are never merged: a known identity always stays with its person, and a second Google (or Microsoft) account for an email whose person already has one is refused (`#/login?refused=other-account`). An unproven email is `#/login?refused=unverified`. The person's own name, once set, is kept over the provider's; the email is set once and not changed by later sign-ins.
- **Tokens** (`auth/metro-tokens.ts`): a sign-in that is let in creates an `auth_sessions` row (method `google`, `microsoft` or `link`) and answers today's shapes. The access token is `mintAccessToken` with `sub`, `sid`, and `org_id` and `role` of the person's first organization by name (none when they have none), 10 minutes. The refresh token is `mrt_` and 32 random bytes in base64url, kept as its SHA-256 only, rotated on every `/refresh`, `/switch` and `/organization`; the previous one works for 60 seconds, and its use after that revokes the session. A session ends after 30 idle days and after 90 days in any case. `/refresh` with `organization` and `/switch` mint for that organization only for a member of it (a refresh for an organization the person left ends the session, as WorkOS did; a switch to one they are not in is a 404). `/logout` revokes the session.
- **WorkOS sessions move over silently**: `/refresh`, `/switch` and `/organization` also take a WorkOS refresh token (anything without `mrt_`). The api refreshes it with WorkOS once, takes the user id, and answers Metro tokens for the same ids, in a session of method `workos`. A token WorkOS refuses means one new sign-in. This stays until step 4.
- **Organizations and members** come from Postgres through `auth/directory.ts` (`metroDirectory`; `workosDirectory` is the same functions over WorkOS, picked by the switch): the organization list, create (an `org_` and ULID id, the name, a free slug, the creator as admin), rename, the members, roles and removal (the last admin and yourself stay), the operator pages, a connector copy's admin check, an agent move's admin check and the phone notification members.
- **Adding a member**: `POST /api/organization/invitations {email, role}` (admin) adds the person at once, with no email sent, and answers `{added: true, member}`. The page says Add member and tells the admin to ask the person to sign in at https://metro.box with Google or Microsoft using that email. `invitations` is always empty.
- **Login links**, the operator's fallback: on the operator's user page, `POST /api/admin/users/<id>/login-link` answers `{id, url, createdAt}` once, the url `https://metro.box/#/auth/link/<code>`; only the code's SHA-256 is kept, one live link per person (a new one replaces the old), reusable until removed with `DELETE`. The page sends the code to `POST /api/auth/link`, which creates a session of method `link` after the same admission as a sign-in, at most 30 tries a minute per address (`cf-connecting-ip`, else `fly-client-ip`, else the socket). With `workos` the routes answer 409 and 404.
- **The page** reads `accounts` from `GET /api/mode` (an api without the field is `workos`): Google and Microsoft only, Add member, login links.

### The flip

Before:

1. Every box runs beta.337 or later (`/health` answers the version). They all do on 2026-11-16.
2. `METRO_AUTH_SIGNING_KEY` is set on the `metro` app (see The token contract). Check the boot log says `Metro sign-in tokens: on`.
3. A Google OAuth client (Web application) with the authorized redirect URI `https://api.metro.box/api/auth/callback`, and an Entra app registration with "Accounts in any organizational directory and personal Microsoft accounts", a Web redirect URI `https://api.metro.box/api/auth/callback`, a client secret, and the optional ID token claims `email` and `xms_edov`.
4. Set the four secrets on Fly (they do nothing in `workos` mode): `fly secrets set -a metro GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… MICROSOFT_OAUTH_CLIENT_ID=… MICROSOFT_OAUTH_CLIENT_SECRET=…`. Optionally `OPERATOR_USER_ID=<the operator's user_ id>`.
5. On the api machine, `cd /app && bun apps/api/scripts/workos-sync.ts` (a dry run), read the differences, then `bun apps/api/scripts/workos-sync.ts --apply`. Run the dry run again: it must print `Metro already matches WorkOS.`

The flip:

6. `fly secrets set -a metro METRO_ACCOUNTS=metro`. The machines restart. The boot log says `accounts: Metro keeps the users, organizations and members`, with both providers and `signing: true`.
7. Run the dry run once more (it still works in `metro` mode): it must still print `Metro already matches WorkOS.` A difference means someone changed WorkOS between step 5 and 6: fix it by hand on the page (add the member, change the role); `--apply` is refused now.
8. Check by hand: sign in on https://metro.box with Google and with Microsoft (a work account too), switch organizations, open a box, add a member, and on a phone sign in again.

Switching back in the first hours: `fly secrets set -a metro METRO_ACCOUNTS=workos`. Metro sessions keep working (an `mrt_` refresh is still rotated, checked against WorkOS's memberships). What was done in `metro` mode stays only in Postgres: an organization created then does not exist in WorkOS, and its members and anyone new since then must sign in again with WorkOS; a member added by email must be invited again. Run the dry run to see what differs before going back to `metro`.

### Step 4: cleanup

- Remove WorkOS: `apps/api/src/auth/workos.ts`, the email code, the invitations, the `WORKOS_*` secrets, the WorkOS key set and `.jwks` on boxes.
- Rename `workos-token.ts` to a name without WorkOS in it.
- Only after every old WorkOS refresh token had its chance to be exchanged, and every box runs a version that no longer needs WorkOS.

## The order

1. Ship step 1 in a beta. Set `METRO_AUTH_SIGNING_KEY` on Fly during step 1, so every box fetches and caches the Metro key set early.
2. Step 2 can ship at any time. It changes nothing people see.
3. **Every box must run the step 1 beta before the switch.** An older box answers 401 to every Metro token, so the page could not manage it any more. Check each box's version first: its `/health` and `/api/mode` answer it.
4. The switch (step 3, see The flip).
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
- **Microsoft email proof**: `upn` and `preferred_username` are not proof. Trusting them would let any tenant admin take an account by its address. Only `xms_edov: true` proves the email, or a personal account (the consumer tenant) on Microsoft's own mail domains, where the address is the account itself.
- **A stolen refresh token**: rotation and reuse detection end the session the first time both the thief and the owner use it.
- **The WorkOS exchange** needs WorkOS still set up during step 3. Cleanup waits for it.
