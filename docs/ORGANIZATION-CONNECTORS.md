# Organization connectors

Organization connectors are staged behind `METRO_CONNECTORS_ENABLED` on api.metro.box. Leave it unset until a separately approved rollout. Existing agents continue using their local connectors. Merging the setup API and page does not enroll or update agents, import their connectors, or activate organization connectors.

## Agent enrollment

An organization admin creates a one-use ticket with `POST /api/servers/<id>/enrollment`, then gives it to the matching daemon's `POST /api/enrollment`. The daemon registers its signing and sealing public keys with `POST /api/agents/enroll`. Its private keys stay in Metro's protected agent directory, never in the agent's readable view, a bundle or an export.

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

This is a preparation stage, not the relay cutover. Existing per-agent connector setup, OAuth, tool policies, plugin servers and relay behavior stay unchanged, including when memory sync is opted into. Organization snapshots are not exposed as live tools yet. The next runtime rollout must connect this store to the local relay, enforce current assignment and policy before each upstream call, handle tool discovery and plugin publication, and preserve existing local connectors until the migration is separately approved. Live tools, automatic plugin reload and the "Move to organization" migration are not enabled by this change.
