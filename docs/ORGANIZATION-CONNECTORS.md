# Organization connectors

Organization connectors are staged behind `METRO_CONNECTORS_ENABLED` on api.metro.box. Leave it unset until a separately approved rollout. Existing agents continue using their local connectors. Merging the setup API and page does not enroll or update agents, import their connectors, or activate organization connectors.

## Agent enrollment

An organization admin creates a one-use ticket with `POST /api/servers/<id>/enrollment`, then gives it to the matching daemon's `POST /api/enrollment`. The daemon registers its signing and sealing public keys with `POST /api/agents/enroll`. Its private keys stay in Metro's protected agent directory, never in the agent's readable view, a bundle or an export.

The daemon saves a candidate in `agent-key.pending.json` (0600) **before** contacting the API. After a valid enrollment response it saves the active `agent-key.json`, then verifies the signed `/api/agents/session` response. A confirmation failure does not discard the new private key. A failed or interrupted request keeps the pending key, and another enrollment request first checks whether it already committed remotely. If so it finishes locally without consuming another ticket or rotating again. Otherwise it retries with the same candidate and the supplied ticket. A fresh ticket may be required if the previous one expired or was consumed.

Only one enrollment request per daemon directory can run at a time. Overlapping requests return 409 rather than saving keys out of order. An organization change during a request also returns 409. Enrollment belongs to the organization that initiated it, never the new owner.

`agent-key.json` is preferred over the old `box-key.json`. The legacy file is read only when the new file is absent. A damaged new file does not resurrect an old key.

## Deployment compatibility

Migration `0006_agent_keys` renames the old table in place. It preserves key material, assignments, secrets, audit rows and applied migration history. The `box_keys` compatibility view lets the previous API remove keys during an organization move while Fly replaces its machines. It does not support old enrollment upserts. Keep the feature off throughout the deployment and any rollback to the old API.

Enrollment uses `/api/agents/enroll`, `/api/agents/session`, `Authorization: MetroAgent ...` and the `metro-agent-request/v1` signing domain. API and daemon versions must match this protocol. Old routes and signatures are not aliases. Infrastructure addresses containing `box` are not renamed.

## Secrets and rollout

Secrets in Postgres are sealed with AES-256-GCM under one `METRO_CONNECTORS_KEY` Fly secret, with organization and connector identity as additional authenticated data. The browser never receives them. Do not replace an existing key: there is no key rotation or re-sealing flow yet.

OAuth sign-in, the organization setup page, assignments and policies are implemented. Central refresh and runtime delivery are separate from setup. Enabling the setup switch alone must not migrate existing per-agent connector configuration. No tool call is relayed through api.metro.box.
