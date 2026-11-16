# Copying WorkOS into Metro's own tables

Metro is leaving WorkOS and will keep its organizations, users and members itself (decided 2026-11-16). Step 2 added the tables (`apps/api/drizzle/0028_own_accounts.sql`, see CLAUDE.md, Database) and a one-time export that fills them from WorkOS. They are read once api.metro.box runs with `METRO_ACCOUNTS=metro` (step 3 of `docs/OWN-ACCOUNTS.md`, which has the flip checklist); until then sign-in, members and invitations still go through WorkOS.

## What it copies

- **Organizations**, with their names (`organizations.name`). An organization Metro has no row for gets one, with a free slug made from its name.
- **Users**, with their WorkOS id (`user_…`), email, name and picture. The ids stay the WorkOS ones, so no owner, `.owner` file or link moves. When a row that WorkOS does not list holds the email of a WorkOS user, the email moves to the WorkOS user.
- **Active memberships**, with their role (`admin`, anything else becomes `member` and is listed as a warning).
- **Pending invitations**, as memberships for that email, role kept. A new email gets a user row (`user_` plus a ULID). No email is ever sent.
- **Google and Microsoft sign-ins** (`GET /user_management/users/<id>/identities`). Google's id is the `sub`. WorkOS's Microsoft sign-in takes personal accounts only, so a Microsoft id becomes `<consumer tenant>:<oid>`: the tenant is always `9188040d-6c67-4c5b-b112-36a304b66dad`, and a 16-hex account id `xxxxyyyyyyyyyyyy` becomes the oid `00000000-0000-0000-xxxx-yyyyyyyyyyyy` (an id already in that shape is kept). Any other Microsoft id is left out and listed; that person is linked by email at their next sign-in. This mapping has not been checked against a real Microsoft token yet.
- People with **neither Google nor Microsoft** (GitHub only, or email code only) are counted and listed: they will need Google, Microsoft or a login link.

Memberships WorkOS no longer has are removed, also those of an organization WorkOS does not list (its row stays). Identities and users are added or updated, never removed. WorkOS listing two users with one email stops the export before anything is written.

## Running it

It runs on the api's own machine, which has `DATABASE_URL`, `WORKOS_API_KEY` and `WORKOS_CLIENT_ID`, and every list is read page by page:

```
fly ssh console -a metro
cd /app && bun apps/api/scripts/workos-sync.ts
```

That is a dry run: it reads WorkOS and the database, writes nothing, and prints the WorkOS counts, the changes per table, every difference (`+` added, `~` changed, `-` removed), the people who need another sign-in and the warnings. Run it again with `--apply` to write everything in one transaction; any failure rolls the whole write back. A second run after `--apply` prints `Metro already matches WorkOS.`, so it can be run again right before the switch. With `METRO_ACCOUNTS=metro` only the dry run works: `--apply` is refused, since Metro is the source then.

The code is `apps/api/src/workos-sync/` (`snapshot.ts` reads WorkOS, `plan.ts` compares, `apply.ts` writes, `report.ts` prints) and `apps/api/test/workos-sync.test.ts` drives it against the fake WorkOS and PGlite.
