# Gmail channel

Metro connects Gmail and Google Workspace mailboxes to an agent. Each mailbox is a separate
channel. Each email thread is a separate line.

The managed connection uses Metro's Google OAuth application. Ordinary users do not create a
Google project or paste client keys. A new connection requests read-only Gmail access. Sending
requires another Google consent flow and a separate Metro write permission.

**Release status:** deployment is approved after security review and the repository and browser
checks pass. Managed Gmail stays disabled until the API explicitly sets `METRO_GMAIL_ENABLED=true`,
even when all credentials are configured. Google application setup, verified routing and any
required public verification remain activation or launch prerequisites. Local tests use synthetic
accounts and provider responses. They do not prove that Google has approved the application or
that live consent, refresh, mail delivery or revocation works.

## Connect a mailbox

Use the web app at https://metro.box. Gmail's browser return does not yet complete inside the
native Metro app.

1. Open the agent, choose **Channels**, then **Connect channel** and **Gmail**.
2. Leave the managed connection selected. Optionally enter the mailbox, such as
   `reader@example.com`. If entered, Metro refuses any other mailbox even if Google selects it.
3. Start sign-in, open **Sign in with Google**, choose the account and approve read-only access.
   Keep the original Metro tab open. Google returns to metro.box and the original tab shows the
   connected channel.
4. Review **People** and the channel's Metro permissions. New Gmail connections start with
   **Write** blocked.
5. Repeat for another mailbox. The same mailbox cannot be attached twice to one box.

A daemon that does not advertise managed Gmail support keeps the older client-key form and
shows an update hint. Daemon support does not mean the shared Google application is configured;
if the API is not configured, managed sign-in fails without attaching a mailbox.

### Allow sending later

Open the mailbox's **Gmail access** section and choose **Allow sending with Google**. Approve
sending for the same mailbox. Metro uses the saved mailbox, not an editable address from the
upgrade request. A failed, declined or cancelled upgrade leaves the channel unchanged.

The upgrade keeps the channel ID, People list, Receive messages setting and Metro permissions.
It does not unblock Write. Choose **Allow** or **Ask** separately when the agent should send.
Setting Write back to Block prevents Metro sends but does not remove Google's send scope. To
remove that scope at Google, remove the app's authorization and connect read-only again.

### What the channel does

- It checks the Inbox every 30 seconds with the Gmail history API. The first check records the
  cursor without replaying old mail. An expired history cursor starts over quietly.
- It skips automated mail, including no-reply senders, mailing lists and bulk mail.
- A sender is verified only when Google's own authentication result passes DMARC, or DKIM from
  the same From domain. With a restricted People list, unverified mail is dropped.
- `read` uses Gmail search syntax, for example `from:sender@example.com has:attachment`.
- With Google send consent and Metro write permission, `send` on a thread replies to everyone,
  `reply` answers one message's sender, and `send` to `metro://gmail/<account>/<email address>`
  starts a new email. Files are limited to 25 MB per email.
- It does not mark mail read, change labels, archive mail or delete mail.

## Google scopes

| Connection | Requested scopes |
| --- | --- |
| New managed or BYO connection on a supporting daemon | `https://www.googleapis.com/auth/gmail.readonly` |
| Explicit sending upgrade | The read-only scope plus `https://www.googleapis.com/auth/gmail.send` |

No `gmail.modify`, full-mailbox scope, identity scope or OpenID token is requested. The Gmail
profile endpoint identifies the mailbox. Initial authorization does not request inclusion of
prior grants. The sending upgrade uses Google's incremental authorization flag,
`include_granted_scopes=true`.

Metro requires exactly the requested scopes on code exchange and every refresh for new
connections. Missing scope, missing permission or any extra permission is refused. A prior grant
under the same Google project can make the combined scopes too broad. Review that application's
Google authorization and reconnect; Metro does not silently treat a broader token as read-only.
Existing BYO accounts without stored scope metadata retain their previous behavior and are not
labelled read-only. A Metro Write toggle alone is not evidence of a read-only Google token.

Google classifies `gmail.readonly` as **Restricted** and `gmail.send` as **Sensitive**. Read-only
here means that Google does not authorize sending or mailbox changes. It still authorizes reading
mail contents and attachments, not only new mail or only approved senders.

## Owner-admin setup for the managed application

These are deployment prerequisites, not steps ordinary users perform. Creating a project,
accepting terms, paying for assessments, submitting verification, changing production secrets
and connecting real mailboxes require separate owner authorization.

1. Use a Google Cloud project controlled by Metro's owner. Enable the **Gmail API**.
2. Configure the Google Auth Platform branding, support and developer contacts, audience,
   authorized domains, public homepage and privacy policy. An **External** audience is needed
   for customers outside the project's Workspace. An Internal application only serves its own
   organization and is not a public managed connection.
3. Create an OAuth client of type **Web application**. Register exactly `https://metro.box/`,
   including the final slash, as its authorized redirect URI. The API redeems codes; no Google
   client secret belongs in the public app bundle or on customers' boxes.
4. Declare the read-only and sending scopes, explain their use, and complete the Google
   verification applicable to the audience and requested scopes. Public use of restricted scopes
   normally requires restricted-scope verification. Google's Gmail scope documentation requires
   a security assessment when restricted-scope data is stored on or transmitted through servers.
   Metro's server-side token handling and box-side mail processing must be included in the owner
   and assessor's review. Do not assume BYO boxes or a small beta exempt the product.
5. Review Google's API Services User Data Policy, Limited Use requirements and Workspace API
   policies against the actual agent processing, storage, disclosures, retention and deletion.
   Publish accurate user-facing disclosures. Do not claim that verification or an assessment is
   complete without Google's and the assessor's evidence.
6. The repository deploys the API to Fly app `metro`. Configure `METRO_GMAIL_CLIENT_ID`,
   `METRO_GMAIL_CLIENT_SECRET`, and `METRO_GMAIL_GRANT_KEY` in that app's protected secrets.
   The grant key is 32 random bytes represented by exactly 64 hexadecimal characters. Generate
   it only for first setup; replacing an existing key invalidates its signed refresh grants. From
   an authorized operator's computer, `fly secrets import --stage -a metro` reads a private env
   file from standard input without immediately deploying the app. Keep values out of shell
   history, chat, source control, public build variables and customer forms. The existing WorkOS
   configuration must be complete. Staged values can reach machines started or updated later;
   staging is not an activation lock. Leave `METRO_GMAIL_ENABLED` absent during code delivery.
   The API requires its exact value `true` as well as all three credentials before managed Gmail
   is available. Deploying the code and credentials without that explicit opt-in leaves managed
   Gmail disabled; existing BYO connections are unaffected.
7. Confirm that the registered box host and organization match the daemon's owner and configured
   HTTPS public address. Pending Google flows live in API process memory for ten minutes.
   A restart loses them. Multiple API instances need routing that keeps start, exchange and cancel
   on the same instance, or a separately reviewed shared single-use state store. There is no
   durable or shared OAuth state store in this implementation. An authorized Fly operator can
   inspect the live machine inventory with `fly machine list --app metro`; the repository's
   minimum machine count alone does not establish a singleton or routing affinity.
8. Only after topology, provider configuration and controlled-test prerequisites are confirmed,
   coordinate explicit activation with the owner by setting `METRO_GMAIL_ENABLED=true` on the
   API and deploying that setting. This is not Google verification or permission to access mail.
   The flag is an initial rollout gate, not a revocation command: removing it also stops managed
   refresh and revocation through Metro without deleting or revoking stored tokens. Once accounts
   depend on the service, keep it enabled until a separate shutdown/revocation plan is complete.
9. Before public release, run an owner-approved live test of consent, exact scopes, wrong-account
   refusal, Workspace restrictions, refresh, sending upgrade, policy enforcement and disconnect.
   The flow sends an S256 PKCE challenge and verifier in addition to confidential-client auth.
   Google's native-app documentation describes these parameters; the web-server documentation
   reviewed for this build does not explicitly establish PKCE support for this client type.
   Verify the configured Web application's behavior before claiming live interoperability.

An External application in **Testing** is restricted to configured test users. Gmail refresh
credentials issued in that mode normally expire after seven days. Moving to Production is not
itself evidence of Google verification. Workspace administrators may block the application or
its requested scopes even after public verification. `admin_policy_enforced` is a policy refusal;
Metro does not bypass it. The administrator must review the application under API controls.

## Public launch and verification evidence

The intended release is public access, not a test-user-only service. These are separate states:

- **External** is the audience. It allows users outside the project's Workspace.
- **In production** is the publishing status. It is not Google approval of branding or scopes.
- **Verified** means the applicable Google review has actually completed. Publishing alone can
  leave an unverified-app warning or user limits. Workspace administrators can still refuse access.

For the branding already configured, verify the authorized domain in Search Console with an
account that is also a project Owner or Editor. The public homepage must explain the application
and link to an accurate privacy notice on the same domain. Google's current branding instructions
use **Verify Branding**, then **Publish branding** after approval. Published branding is a
prerequisite for the data-access review in **Verification Center**.

Prepare these scope explanations for owner review, not as claims of Google's acceptance:

| Scope | Feature and least-privilege explanation |
| --- | --- |
| `gmail.readonly` | Read and search message bodies, threads and attachments, and poll for new Inbox mail. Metadata-only access cannot supply message bodies or attachments. No mailbox modification is needed. |
| `gmail.send` | Send a new email or reply after the user explicitly upgrades Google consent and separately permits Metro Write. Read-only access cannot send; full-mailbox or modify access is unnecessary. |

The verification packet must identify the permitted Gmail use case and actual data processing.
Document the API's transient credential handling, private box credentials, agent/model processing,
configured subprocessors, retention and deletion. Review these against Google's Limited Use and
Workspace data policies. Do not promise that data never reaches a model provider, that every
provider has zero retention, or that a general-purpose agent automatically qualifies for approval.

The owner-submitted unlisted demonstration video must show the real English consent flow, app
name and client ID, and the feature enabled by every requested sensitive or restricted scope.
Include initial read-only connection, reading/search, the separate sending upgrade and the sending
feature with Metro permission. Use an explicitly approved demonstration mailbox and non-sensitive
sample content. Actual mailbox reading or sending needs separate authorization. Synthetic browser
screenshots do not demonstrate Google interoperability and must not substitute for this video.

Restricted data stored on or transmitted through servers requires Google's applicable independent
security assessment unless a documented exception applies. Include Metro's API and box processing
in that review; do not assume a BYO-box exemption. Google's restricted-scope guidance specifies an
approved CASA assessor and recurring assessment within each twelve-month period after approval.
An internal code review is not that assessment. Submission, legal acceptance and commissioning or
paying an assessor remain owner actions, not effects of deploying this code.

An existing Web client with the exact callback may be reusable. A separate client can separate
credentials, but clients in the same project do not have independent consent/revocation boundaries.
Google's combined authorization can include grants from different clients in that project, and
revocation can invalidate that Google account's tokens across all of them. Review existing uses
before choosing a client or project; do not silently migrate them.

Owner consoles and requirements:

- Audience and publishing: https://console.developers.google.com/auth/audience
- Scope declaration: https://console.developers.google.com/auth/scopes
- OAuth clients: https://console.developers.google.com/auth/clients
- Domain ownership: https://search.google.com/search-console/
- Branding: https://console.developers.google.com/auth/branding
- Scope review: https://console.developers.google.com/auth/verification
- Branding requirements: https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- Restricted-scope requirements: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Workspace administrator controls: https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data

## Credential and authorization boundaries

- In the managed UI flow, the browser sees the Google authorization URL, callback code/state
  and connection status, not Google access tokens, refresh tokens, refresh grants or the shared
  client secret. The callback query is removed before the return UI makes requests. Credential
  POSTs at the API reject requests carrying `Origin` or any `Sec-Fetch-*` header. This is browser
  defense, not proof that a non-browser caller is physically on a registered box.
- The originating daemon creates the PKCE verifier. API state binds the initiating WorkOS user,
  organization and session to the registry server ID, exact host, local agent ID, challenge,
  requested mailbox and send permission. It expires and is consumed once. A mismatched actor
  or target cannot consume it; a bound exchange attempt consumes it even when PKCE or Google
  refuses. The callback URL is fixed, and tokens are returned to the calling daemon rather than
  sent to a URL supplied in the request.
- The browser pins the initiating user, organization and WorkOS session as well as the original
  daemon address. Account changes block further attach requests, including cancellation and
  callback submission, rather than sending the new account's bearer to the old box. The daemon
  sends the code and verifier to the fixed Metro API over HTTPS. The API checks current user
  and membership status and the exact saved server before and after Google's response.
- Start admission permits five attempts per WorkOS user per rolling ten minutes across sessions,
  organizations and boxes. At capacity, new starts are refused rather than evicting live sign-ins
  or another user's admission budget. Pending state and admission budgets are process-local.
- **Google tokens transit the Metro API in plaintext in process memory.** The API redeems and
  refreshes them but does not persist them in a central credential database. It returns them
  server-to-server to the daemon. API request/response bodies, authorization headers and callback
  queries must not be logged by application, proxy or observability configuration.
- Tokens and a signed refresh grant remain in Metro-owned private account/state files on the
  box. The station saves a rotated token and grant together in a 0600 state file. The shared
  Google client secret and grant-signing key remain at the API. Agent-readable view files carry
  none of these credentials. This relies on the existing Metro/agent OS-user separation.
- The signed refresh grant binds a digest of the refresh token to the user, organization, server,
  host, local agent and mailbox, and records the approved send permission. It renews after a
  successful refresh and expires after 90 days without renewal. It is a **bearer capability**,
  not physical box attestation. A registered hostname alone does not prove possession of a box.
- A local owner or public-address mismatch blocks even a still-valid access token. The daemon
  resets a private `.gmail-host` snapshot before trains start and updates it immediately when
  its tunnel address changes. The station reads that snapshot and `.owner` before and after
  provider requests and before returning mail or attachments. Registry changes are checked
  again on refresh. Removing a user or a registry entry blocks future refresh, but cannot recall
  a Google access token already issued to a box. Such tokens may remain valid until Google
  expires or revokes them.
- Managed connections are excluded from `.metro` exports and rejected on import. Connect each
  managed mailbox again on the destination box. BYO exports retain their existing behavior.

Closing a pending sign-in cancels the local attempt and discards any late exchange result.
Cancellation does not remove authorization already granted at Google. Automatic revocation on
cancellation could disconnect other uses of the same application, so remove unwanted access in
the Google Account settings yourself.

## Disconnect

Deleting a managed Gmail channel asks its running Gmail service to stop new requests, wait for
any in-flight token refresh and revoke the latest saved token/grant pair. A concurrent sending
upgrade cannot commit during deletion. The daemon checks the owner and connection revision again
before removing the channel. If the Gmail service is unavailable or revocation is unconfirmed,
the channel is kept for retry rather than claiming that access was removed.

A verified grant that has expired may authorize revocation only, never refresh. Google's exact
`invalid_token` revocation response counts as already revoked; an arbitrary error does not. On
confirmed revocation, Metro removes the local connection and attempts to remove its private
state. Cleanup errors are logged, and startup also reaps orphan state files. Deleting a channel
does not erase mail already delivered into an agent's conversations or its saved attachments.

**Google revocation is project-wide for that Google account.** Google's documentation says it
removes all scopes and invalidates issued access and refresh tokens for all clients registered
under the project. Deleting one managed connection can therefore disconnect that same Google
account from Metro on other boxes too. It does not revoke another Google account's access.

BYO deletion keeps the existing behavior: it removes local credentials. Remove the BYO app's
Google authorization separately at https://myaccount.google.com/permissions when needed.

### Owner recovery and key rotation

The API currently accepts one grant-signing key and one Google client. It has no old-key ring or
migration path. Changing the grant key or client ID invalidates existing grants, including their
normal revocation path. A client-secret rotation for the same client ID does not change grant
identity, but must preserve working Google refresh credentials.

Before a planned grant-key or client-ID change, arrange disconnection under the old configuration
and then reconnect under the new configuration. Keep the old configuration in the operator's
protected secret store for the agreed recovery window, never in chat or an agent's files. Do not
restore a compromised key simply to recover cleanup. If the old configuration is lost or unsafe,
users must remove the app's access at https://myaccount.google.com/permissions. Metro cannot then
prove revocation with the lost key and intentionally keeps the channel; owner-led cleanup is
required. There is no silent local-delete fallback that claims Google's access was removed.

## Advanced: bring your own Google application

The **Use your own Google app** option keeps existing client-key accounts compatible. Use a
project you administer, enable Gmail API and create a Web application OAuth client with exactly
`https://metro.box/` as its redirect. Supply that client's ID and secret in the advanced form,
not in chat. The box stores them beside its own refresh token and talks directly to Google.

An Internal application may suit mailboxes in one Workspace. External applications have their
own testing, verification and assessment obligations. A Workspace admin may need to allow the
client under API controls; do not weaken organization policy just to suppress an error. BYO
connections on supporting daemons start read-only and use the same explicit sending upgrade.
Legacy connections are neither silently downgraded nor relabelled as read-only.

## If something refuses

- **Managed sign-in is not configured:** the API's shared application prerequisites are missing.
  Ordinary users should not be asked to create client keys to finish the managed flow.
- **Expired or already used sign-in:** start a new attempt in the original account and box.
  Restarting the API or daemon, signing out, switching organization or changing WorkOS session
  can invalidate the attempt.
- **Different mailbox:** start again and choose the mailbox entered in the form.
- **Unexpected or missing scope:** Metro refuses the token. Review prior app permissions and
  reconnect; a successful Google page alone does not mean Metro attached the mailbox.
- **`redirect_uri_mismatch`:** the app owner must register the exact return URI, including `/`.
- **`org_internal`:** the selected account is outside an Internal application's Workspace.
- **Workspace policy refusal:** ask the Workspace administrator to review the OAuth client.
- **Refresh refused:** Google may have revoked or expired access. Testing mode, inactivity,
  password changes, user time limits and refresh-token limits can cause this. Reconnect.
- **Box owner/address changed:** reconnect under the current owner and registered address.

## Official references

Reviewed on 2026-10-06. Requirements can change; verify them again before launch.

- Web-server OAuth, refresh, incremental authorization and revocation:
  https://developers.google.com/identity/protocols/oauth2/web-server
- Gmail scope classification and assessment rule:
  https://developers.google.com/workspace/gmail/api/auth/scopes
- Token expiration and limits:
  https://developers.google.com/identity/protocols/oauth2
- PKCE parameter documentation for native apps:
  https://developers.google.com/identity/protocols/oauth2/native-app
- Google API Services User Data Policy:
  https://developers.google.com/terms/api-services-user-data-policy
