# Organization connectors

Organization connectors are staged behind `METRO_CONNECTORS_ENABLED` on api.metro.box. Leave it unset until a separately approved rollout. Existing agents continue using their local connectors. Merging the setup API and page does not enroll or update agents, import their connectors, or activate organization connectors.

## Agent enrollment

An organization admin opens the selected agent's **Server** page, clicks **Enroll with organization**, checks the agent and organization in the confirmation, then clicks **Enroll agent**. The page uses the existing WorkOS login to create a one-use, ten-minute ticket with `POST /api/servers/<id>/enrollment`, then gives it to that agent's captured daemon origin at `POST /api/enrollment`. The ID is the central server row, not the local daemon agent ID, EC2 instance ID or slug. No token handling or separate sign-in is needed.

Before minting, the page checks the captured daemon's `/api/mode` response for its organization and enrollment-compatible version (beta.288 or later). This gives old daemons an Update notice without attempting their unsupported POST route.

The page holds the ticket only in memory. A retry in the same dialog reuses an unexpired ticket so the daemon can recover an interrupted confirmation while its pending key still exists. If the daemon already finished and discarded its pending record, a lost browser reply can instead produce a definite consumed-ticket refusal. The page explains this and discards the ticket; the next explicit retry obtains a fresh one and may replace the existing enrollment identity. Closing the dialog discards the ticket too; starting again obtains a fresh ticket. Account or agent changes abort the request and invalidate the dialog's operation, including a switch away and back. Closing or aborting cannot undo enrollment already received by the daemon, so an interrupted request is not reported as an unchanged agent. A successful response must match the captured organization and central server ID.

Enrollment does not enable delivery or live tools, assign or move connectors, or change rollout switches. It replaces an existing enrollment identity if the agent was already enrolled. Setup-off and old-daemon failures are explained without displaying remote response text. The daemon registers its signing and sealing public keys with `POST /api/agents/enroll`. Its private keys stay in Metro's protected agent directory, never in the agent's readable view, a bundle or an export.

The daemon saves a candidate in `agent-key.pending.json` (0600) **before** contacting the API, flushing the file and directory to disk. This recovery record includes a hash of the ticket, not the ticket itself, and the expected agent identity once known. Only a matching signed `/api/agents/session` confirmation promotes it to the active `agent-key.json`. The active file is flushed before the pending copy is removed. A confirmation failure keeps the pending private key and leaves the previous active file unchanged.

Retrying the same ticket first checks whether that candidate already committed remotely. If so it finishes locally without consuming the ticket again. A different ticket always goes through enrollment with a new key, after preserving any recovered old identity. Only an explicit missing-key response permits a retry of the enrollment exchange: outages, clock errors and inconsistent identities are reported without consuming another ticket. Unreadable pending files are never overwritten. A fresh ticket may be required if the previous one expired before enrollment committed.

Only one enrollment request per daemon directory can run at a time. Overlapping requests return 409 rather than saving keys out of order. An organization change during a request also returns 409. Enrollment belongs to the organization that initiated it, never the new owner.

`agent-key.json` is preferred over the old `box-key.json`. The legacy file is read only when the new file is absent. A damaged new file does not resurrect an old key.

## Deployment compatibility

Migration `0006_agent_keys` renames the old table in place. It preserves key material, assignments, secrets, audit rows and applied migration history. The `box_keys` compatibility view lets the previous API remove keys during an organization move while Fly replaces its machines. It does not support old enrollment upserts. Keep the feature off throughout the deployment and any rollback to the old API.

Enrollment uses `/api/agents/enroll`, `/api/agents/session`, `Authorization: MetroAgent ...` and the `metro-agent-request/v1` signing domain. API and daemon versions must match this protocol. Old routes and signatures are not aliases. Infrastructure addresses containing `box` are not renamed.

## Secrets and rollout

Secrets in Postgres are sealed with AES-256-GCM under one `METRO_CONNECTORS_KEY` Fly secret, with organization and connector identity as additional authenticated data. The browser never receives them. Do not replace an existing key: there is no key rotation or re-sealing flow yet.

OAuth sign-in, the organization setup page, assignments and policies are implemented. Central refresh and memory sync are separately gated from setup. Enabling the setup switch alone does not migrate existing per-agent connector configuration. No tool call is relayed through api.metro.box.

## Central refresh and signed delivery

The staged `POST /api/agents/connectors` endpoint requires both `METRO_CONNECTORS_ENABLED=true` and `METRO_CONNECTORS_DELIVERY_ENABLED=true`. Neither is enabled by default. A browser or a user bearer token cannot fetch credentials. The enrolled agent signs each request with its private key. Durable database nonces prevent replay across API processes and restarts.

OAuth refresh is serialized by a database row lock, not an in-process lock. The service rereads the encrypted current token under that lock and preserves a rotating refresh token. A forced refresh names an opaque prior credential revision so simultaneous retries do not refresh the newly issued token twice. An invalid grant requires sign-in again; a transient provider failure must not erase the saved refresh token.

Only current, same-organization assignments can be delivered. Authorization, assignment and policy checks run again after slow refresh work. Connector-level and assignment policies are combined without allowing either to weaken the other. Delivery includes the target URL, access header, policy and opaque revision, never an OAuth refresh token or client secret. The full payload is sealed to the enrolled agent's X25519 key and bound to its organization, agent ID, key ID and random request ID.

Snapshots have a lease of at most 90 seconds. This limits how long Metro can retain the delivery; it does not shorten a vendor's access token or API key lifetime. Tokens with an earlier expiry cannot be used beyond it. Credential lifetime is measured from the API's snapshot issue time, then reduced by monotonic request time, so an allowed clock difference cannot extend it. Responses are bounded, not silently truncated, and are not cacheable.

Refresh and delivery events retain connector names but never URLs, headers, tokens or encrypted payloads. A delivery event records inclusion in an authorized sealed response, not proof that the agent received or decrypted it. Activity therefore says Metro prepared the connector for the agent.

## Staged daemon memory sync

The daemon also requires its separate `METRO_CONNECTORS_SYNC_ENABLED=true` flag. With it unset, boot makes no organization connector request. With it enabled and the agent enrolled in its current organization, the daemon retrieves an encrypted snapshot at start and every minute. Overlapping polls share a request. The snapshot lives in an isolated memory store only, never `connectors.json`, the plugin configuration, a policy file, the agent view, a bundle or an export.

Memory is cleared on sync failure, lease expiry, owner change, enrollment-key change or shutdown. A response that was already in flight before an owner change cannot install credentials afterward, even if the organization changes back. Both monotonic elapsed time and wall time bound the lease, so a slow response or a backward clock adjustment cannot extend it.

Memory sync alone is still a preparation stage, not the relay cutover. Existing per-agent connector setup, OAuth, tool policies and relay behavior stay unchanged when only memory sync is opted into. No organization connector is published as a live tool unless the separate runtime switch below is also enabled.

## Opt-in local tool runtime

`METRO_CONNECTORS_LIVE_ENABLED=true` on the daemon opts assigned organization connectors into its local relay. It also requires the daemon sync flag, both API flags and a current enrollment. All flags remain off by default. This code does not set them, enroll or update agents, move connectors, or reload a running plugin.

The daemon publishes local and organization connectors through one combined path. Local server keys stay unchanged. Organization relay IDs and plugin server keys are source-qualified and collision-safe, even when a local connector has the same name or ID. Local setup, sign-in, copy, bundle and export remain local-only. Organization credentials, target URLs and credential revisions never enter plugin or policy files. Only names, IDs, effective policies and tool read/write groups are published.

Before each organization vendor request, including an auth retry and each tool-discovery request, the daemon completes a fresh signed API delivery check. It then synchronously rechecks its current identity, assignment, lease, availability and effective tool policy immediately before sending. This is a control-plane check, not a central tool proxy: tool arguments and results still travel directly between the daemon and the vendor. A policy edit immediately after the API's check can still race a request already being sent; there is no cross-network atomic revocation guarantee.

Discovery uses the same bounded HTTP MCP helper as local connectors. Read/write groups stay in memory, unknown tools count as write, and stale discovery cannot restore removed access. Organization relay POSTs accept the MCP tool protocol and its handshake only, not arbitrary resource or prompt methods that could bypass tool policy. Caller credentials are stripped, vendor credentials are injected only at dispatch, and redirects remain refused.

An upstream 401 or 403 permits one central refresh and one retry, using the revision of the credential actually rejected. Discovery has one OAuth refresh budget for its entire scan, shared across all pages; a relay request has one auth retry. The retry rechecks the policy. An approval is scoped to that exact request and may cover its credentials-only retry, not duplicate batch entries or later calls. Removal or policy changes revoke obsolete approvals. API failures, expired leases, owner/key changes and revocation fail closed and abort active organization streams without disabling local connectors. A vendor refusal becomes 424, never the daemon's own 401; missing assignments and temporary failures keep distinct statuses. The runtime never signs out or rewrites a local connector.

After a complete sync failure or expiry, an organization call may need to wait for the next successful minute poll before it is available again. New or renamed plugin servers still need `/reload-plugins --force` or an agent restart; a stale client cannot use a removed server merely because it still displays it. Per-request checks also consume the existing signed-request nonce budget, so a pilot must measure control-plane load and rate-limit behavior.

Production activation, a matching daemon release and pilot, immediate page-triggered sync, automatic plugin reload, key rotation and the actual "Move to organization" cutover remain separate rollout work. No production secrets or existing connectors are changed by merging the runtime or preview code.

## Migration preview, not a move

The agent's Connectors page has an admin-only **Move to organization** entry. It opens a read-only preview, not a confirmation or an import. `GET /api/connectors/migration-preview` requires an organization admin and the existing daemon `METRO_CONNECTORS_SYNC_ENABLED=true` switch. It is off by default, and an older daemon gets an explicit Update notice. No new flag is introduced. Do not enable sync just to view a production preview: that same switch starts the memory-sync runtime described above.

The preview reads protected local settings without changing them. It does not verify a server, register an OAuth client, refresh a token, enroll an agent, publish tools, copy credentials, create a connector, change a policy or assignment, or delete anything. Its browser response contains only IDs, names, URL origins, authentication categories, complete valid policies and fixed reason codes. Full URLs, paths, queries, headers, tokens, client credentials and secret-derived fingerprints are excluded. Invalid settings block preparation rather than silently becoming an unauthenticated connector.

The client then reads the current organization's existing connector metadata. A name conflict is not merged or renamed. A shared origin is only a possible duplicate service, not proof of the same endpoint or login; different names or origins can still hide a duplicate. Failed organization reads do not become an empty, conflict-free list. The preview is an advisory snapshot, not a reservation, verification result or authority to change anything. Closing it needs no rollback because it changes no connector state.

### What blocks a safe cutover

- **Permissions:** local policies can include `ask` and per-tool rules. Current organization management exposes only default access or read-only and can replace a whole policy when that switch changes. The preview preserves and shows the full valid local policy, and blocks a non-lossless mapping. Do not silently weaken or tighten it. Custom-policy editing and its interaction with assignment policy need a tested preservation path before those connectors can move.
- **Duplicate access:** assigning an organization copy leaves the local tool server usable. Distinct server keys prevent collisions, not duplicate access. Removing a local plugin entry alone is insufficient: the old relay ID and local refresh/sign-in paths must also stop, including in-flight work. There must be no automatic fallback to local credentials after organization revocation or outage.
- **OAuth:** copying a rotating refresh token lets the old daemon and the central service race. The saved local client also may not allow the central callback, and its registration-management credentials are not retained. Use fresh central authorization instead of token transplantation. A manually registered provider must allow `https://api.metro.box/api/connectors/callback`, or use a separately registered client. Even fresh sign-in can invalidate an older grant at some providers; old-token backups do not guarantee OAuth rollback.
- **Recovery and idempotency:** an actual move needs a durable mapping from organization, enrolled agent ID and local connector ID to its destination, plus resumable pending state. Create a new destination unassigned, preserve the exact policy, verify it, then explicitly switch the source agent to exactly one active path. Retries must reconcile the recorded destination instead of creating duplicates. Filesystem, database and provider changes cannot be one atomic transaction.

These safeguards are not implemented by the preview. Existing local setup, copy and export remain unchanged. Do not use **Copy all** as a migration shortcut.

### Rollback boundary

For this preparation step, close the preview. No state needs restoration. Before any future cutover, retain a protected recovery record and an operator-controlled encrypted backup; do not export plaintext bundles or credentials into chat, logs or a development checkout.

An actual rollback must disable the migrated organization path on that agent, reverse only the assignment created by that move, and restore its retained local configuration. It must not remove another agent's assignment, overwrite an independently edited connector, or delete a destination that became shared. A stale local OAuth grant may require fresh local sign-in. Until those operations are implemented and tested, there is no supported automatic move or rollback button, and existing production connectors must remain local.

## Approved pilot checklist

Preparation and a merged PR do not authorize these production steps. The operator must approve the agent and test connector, package update, enrollment, each activation switch and any later credential migration separately.

1. Review and merge the preparation PR only after its tests and security review pass. Publish the matching daemon as a **beta** using the existing publish workflow. Do not publish an unmerged migration branch as the production beta. The operator then clicks **Update** for only the selected pilot agent. A page deploy does not upgrade its daemon.
2. Use one operator-owned agent and one non-production, read-only test connector. Do not start with shared production OAuth or a connector already active locally. Confirm the agent belongs to the intended organization.
3. On api.metro.box, verify the existing `METRO_CONNECTORS_KEY` is present and safely backed up. If this is first-time setup, the operator securely generates 32 random bytes in base64 and stores the key as a Fly secret with a protected backup. Never replace an existing key or put its value in chat. Enable `METRO_CONNECTORS_ENABLED` only with approval; this opens setup, not delivery or migration.
4. Create the test connector centrally, sign in there if required, and assign it only to the pilot with a read-only policy. Record the new connector and assignment IDs without credentials. As an organization admin, open that agent's **Server** page, choose **Enroll with organization**, check the named agent and organization, then confirm **Enroll agent**. The daemon checks its signed session before the page reports enrollment confirmed. This does not activate delivery or tools.
5. With separate approval, enable API `METRO_CONNECTORS_DELIVERY_ENABLED` and daemon `METRO_CONNECTORS_SYNC_ENABLED`, leaving daemon `METRO_CONNECTORS_LIVE_ENABLED` off. Verify memory-only delivery and expiry using test credentials. The preview is now available; it must report blockers without changing source files or assignments.
6. With approval for live test calls, enable daemon `METRO_CONNECTORS_LIVE_ENABLED` on only the pilot. Run `/reload-plugins --force` or restart the client to load new server names; reconnect `/mcp` after a daemon update. Check one allowed read, a denied write, revocation during an active stream, token expiry and one forced-refresh retry. Measure control-plane request/nonce budgets and provider behavior.
7. To stop this non-migrating pilot, disable its live/sync switches, remove only the test assignment if approved, and reload plugins. Existing local connectors remain usable. API delivery can be turned off as the wider emergency stop, but it affects every opted-in agent. Do not delete existing local connectors, run a live data migration or upgrade other agents as pilot cleanup.

Success on this pilot is evidence for a later explicit cutover decision, not approval to move everyone's credentials. The outstanding code remains policy-safe, duplicate-free, resumable cutover and rollback, not another broad architecture phase.
