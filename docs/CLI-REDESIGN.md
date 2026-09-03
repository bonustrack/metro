# Metro CLI redesign: local-first, portable, wallet-keyed

Status: proposal, decisions frozen on 2026-09-03. Revised the same day: bundles live in Postgres, not R2; collections are removed and agents own connectors; the local daemon serves the UI and wallet signing happens there, not in the CLI. No code yet beyond what section 11 lists.

## 1. Goals and non-goals

Goals

- An agent runs on a machine with no account, no browser and no pairing code: install, `init`, `add`, `claude`.
- The agent is a thing you can pick up: one directory, moved between servers in one command, with its stations, credentials, connectors, memory and Claude Code profile intact.
- metro.box holds only ciphertext for anything secret. "Metro cannot read your credentials" becomes true, not a caveat.
- One identity: the Ethereum wallet that unlocks the agent is the one that signs in to metro.box. No recovery phrase to store. An agent can be unlocked by more than one wallet, so a team member can take it over without the owner's keys.
- One concept for "what an agent can reach": its stations and its connectors both hang off the agent. No collections.
- The dashboard works without metro.box: the local daemon serves the same UI, reachable from a laptop or a phone.
- Every command works for a person and for an agent: prose by default, `--json` everywhere, fixed exit codes, no prompts without a TTY.

Non-goals

- Running messenger stations on hosted metro. The rule stays: metro never runs a messenger station.
- Keeping Google sign-in. SIWE replaced it outright (migration `0020`), on metro.box today and on the local daemon later.
- Supporting smart-contract or MPC wallets as key sources (see 4.2).
- Object storage. Bundles are bounded and versioned in Postgres; moving them out is a later decision if sizes ever demand it.

## 2. What the code already gives us (verified)

- `StationSource = () => Promise<LoadedAgent[]>` in `apps/mcp/src/db/materialize.ts`, with `LoadedAgent { id, name, accounts: [{ station, id, allowlist, config }], key }`. `pgSource` and `httpSource` implement it; nothing below the seam branches on mode. A `fileSource` is a third implementation.
- `localAgentKey()` and `registerKey` already handle the MCP key for a daemon not backed by Postgres.
- `prepareAccount` (`stations/attach.ts`) verifies discord-bot, telegram-bot, webhook and xmtp against the real provider and returns the config; `attachAccountToAgent` is the Postgres write. Local mode replaces only the write. telegram (user account) and whatsapp are interactive and live in `AttachSessions`; the CLI drives those prompts itself.
- The runtime lease (`db/runtimes.ts`) is a complete single-holder fence and stays the authority in linked mode.
- The upload endpoint (`daemon/upload-api.ts`) already has the shape a bundle upload needs: `content-length` checked first, a running counter that drains instead of throwing, a hard size cap.
- `daemon/tunnel.ts` spawns `cloudflared`. Untested for local webhooks; spike.
- xmtp config is `{ privateKey: hex }`, so a derived key is a drop-in. Node has `crypto.hkdfSync`. `viem` is a CLI dependency.
- Claude Code honours `CLAUDE_CONFIG_DIR` and, from v2.1.234, `CLAUDE_CODE_PROJECT_DIR_NAME`, so a whole Claude profile can live inside the agent directory.
- Collections touch about fifty files (`collection-api.ts`, `connector-collections.ts`, `connector-relay.ts`, `cli-pair*.ts`, `session.ts`, the UI's Collections pages and pickers, `Authorize.tsx`, the CLI's `login`/`whoami`/`mcp`, the plugin skills, ten test files). All mechanical.

## 3. Agents own connectors (replaces collections)

An agent has a list of connectors, exactly as a collection did. Connectors stay project-level rows so one connector can serve several agents; membership moves to `agent_connectors(agent_id, connector_id)`, cascading on both sides.

What changes

- **Uniqueness.** A connector name is unique within an agent (it is the `mcpServers` key that agent exports), checked on attach and on rename. `collidingCollection` becomes `collidingAgent`.
- **The relay** authorizes `/relay/<connector-id>` when the connector is on the token's agent. Nothing else about the relay moves.
- **One pairing code per agent.** `POST /api/agents/<id>/code` replaces both `POST /api/collections/<id>/code` (`mc_`) and `POST /api/agents/<id>/runtime` (`mr_`). The authorize page becomes `#/authorize/<agentId>` for everything, and `#/authorize` lists agents.
- **Tokens.** Two credentials remain, both agent-scoped, one code mints either:
  - the **run token** (`typ: 'run'`, `{ sub, agent, rt }`), for a machine that runs the agent's stations. It takes the lease. It is now also accepted on the relay and on `/api/cli/mcp`, so a daemon machine holds one credential for everything hosted.
  - the **agent token** (`typ: 'agent'`, `{ sub, agent }`, replacing `typ: 'cli'`), for a machine that only wants the agent's connectors, such as a laptop with no daemon. It reaches the relay and `/api/cli/mcp` and nothing else, keeping today's boundary: a token on a laptop cannot read `/api/agents`, create anything, or see other agents.
  - the agent **key** (`mk_`) is unchanged: MCP only.
- **UI.** The Collections page, `CollectionPage`, `CollectionPicker` and `NewCollection` are deleted. The connector kebab's "Add to collection" becomes "Add to agent" with the same staged-selection picker. The agent page gains a Connectors section with the existing `ConnectorChooser` behind an "Add connectors" button. The project sidebar loses its Collections entry.
- **CLI and plugin, in the current CLI**: `metro login` authorizes an agent instead of a collection, `whoami` prints the agent, `metro mcp` exports the agent's connectors; the plugin's `/metro:login` claims the same code. Paths under `/api/cli/*` keep their names until the CLI redesign renames them, so nothing published breaks twice.

Migration (`0019`, hand-written, one-way)

- Create `agent_connectors`.
- **No agent is minted for a collection.** The migration moves the one production collection that had to survive (`Internal`, `tnlSpfBErt0`) onto the existing agent `Tony` (`bMcXH2uERTe`), guarded so it is a no-op on any database without that agent, and drops every other collection (`Support`, `MCI Group`): their connectors stay in the project, held by nobody, and are added from an agent's page when wanted. Less's call, 2026-09-03.
- Drop `collection_items` and `collections`.
- Existing `typ: 'cli'` tokens stop verifying, which the CLI already reports as "run `metro login` again".

This phase ships first, in the current codebase, because it needs nothing from local-first and every later phase is simpler without collections.

## 4. Architecture

### 4.1 The agent directory

```
~/.metro/agents/<name>/
  agent.json      id, name, key, stations with their config, connectors (0600)
  stations/       runtime state that must travel: xmtp db3 (+ sidecars), whatsapp token store
  claude/         a complete CLAUDE_CONFIG_DIR: memory, sessions, MCP registrations, settings, flag cache
  provider.json   { provider: "anthropic" | "bedrock", region, model, credential source }
  lease.json      { machine, since, keyVersion }
  key             the cached derived bundle key while the agent runs here (0600)
```

The directory is the unit of everything: what the daemon reads, what a bundle contains, what moves. Connectors are in it, so a moved agent brings its tools.

### 4.2 Keys

Two layers, so an agent can be opened by more than one wallet.

**A wallet has one deterministic encryption keypair.** It is derived from a single EIP-712 signature that is the same for every agent that wallet touches. These values are in every wrapped key and must not change:

```
domain:  { name: "metro", version: "1" }          // lowercase "metro"
types:   EncryptionKey { purpose: string, keyVersion: uint256 }
message: { purpose: "encryption-key", keyVersion: 1 }
```

`HKDF-SHA256(ikm = signature bytes, salt = "metro", info = "x25519")` → 32 bytes → an X25519 private key; the public key is registered on the wallet's profile (metro.box when signed in, the local daemon at `init`). Nothing is stored that has to be recovered: the same signature reproduces the keypair anywhere.

**An agent has one random data key (DEK)**, generated at `init` and never derived from anything. The bundle is encrypted under it (AES-256-GCM), the agent's XMTP private key is `HKDF(DEK, "xmtp-identity")` so the inbox identity belongs to the agent rather than to a wallet, and the DEK is **wrapped** to each authorized wallet's public key (X25519 sealed box). The wrapped keys travel in the bundle header, in the clear, and are useless without the matching private key.

Rules

- EOAs only. The wallet signs twice at first use; a mismatch means a non-deterministic signer (smart-contract wallets via ERC-1271, several MPC wallets) and the flow refuses. MetaMask, Rabby, Ledger and Trezor are deterministic.
- Each wrapped key records the recipient's address and public key, so the wrong wallet fails with "this wallet does not unlock this agent", never a decryption error.
- The DEK is cached in `key` while the agent runs on a machine. A running machine holds a working key, exactly as it holds bot tokens.
- Rotation of a wallet keypair bumps `keyVersion`; the wallet re-signs and every agent it can open is re-wrapped. Rotation of a DEK (on revocation) re-encrypts at the next snapshot.
- Optional second factor: a passphrase mixed into the HKDF salt, for people who want the wallet not to be sufficient on its own.

Signature acquisition happens in the local UI (section 4.9), with the wallet the browser already has: the injected provider on a laptop, MetaMask's in-app browser on a phone. The CLI never speaks WalletConnect. Fallback for a machine with no browser reachable: paste the hex signature into the CLI. The signature never reaches metro's servers, and (4.9) never crosses a network in the clear.

### 4.3 The bundle

A tar of the agent directory (minus `key`, minus `lease.json`) under AES-256-GCM with the DEK, plus a plaintext header: `{ agent, version, createdAt, includesSessions, recipients: [{ address, publicKey, keyVersion, wrappedDek }] }`. Sessions are opt-in (large, format-unstable); memory is always included.

### 4.4 Storage and sync (Postgres)

- `bundles(id, agent_id, version, key_version, fingerprint, size, sha256, ciphertext bytea, created_at)`. The last three versions per agent are kept; older rows are deleted on insert.
- `PUT /api/agents/<id>/bundle` accepts the run token of the lease holder only. `GET` accepts the run token or the agent token. Both are on the upload endpoint's pattern: `content-length` first, a running counter that drains rather than throws, a hard cap of 64 MiB. A bundle over the cap is refused with the instruction to exclude sessions.
- Bytes transit the Fly box, which is fine because they are ciphertext; the cost is bandwidth and a buffer, both bounded by the cap.
- Upload triggers: station or connector changes, daemon shutdown, and every few minutes while dirty. The XMTP database is snapshotted consistently (SQLite backup API or `VACUUM INTO`), never copied live.
- Download happens only on `import`.

### 4.5 Lease and single-writer

WhatsApp, XMTP and telegram-user are single-writer by nature; the others would double-reply. The rule is therefore uniform: an agent moves, never runs twice.

- Unlinked: `lease.json` is advisory. `export` stops the daemon and marks the source moved; a moved copy refuses to start. `--copy` skips that, for backups.
- Linked: metro.box's runtime lease is the authority, unchanged from today. `import` takes it; the previous holder stops on its next heartbeat.
- `import` prints the two costs that always apply: an XMTP installation is registered per machine (ten per inbox), and a Bedrock API key is region-bound.

### 4.6 The local daemon

- Reads a `fileSource` pointed at the agent directory.
- Exposes an admin API on a Unix socket in the agent directory (0600). Authentication is OS ownership; no tokens. `status`, `logs`, `tail`, `add`, `remove`, `tools`, `sync` go over it.
- The MCP endpoint keeps its key; only `metro claude` ever handles it.
- Auto-starts on first use from any command; `service install` makes it survive reboots.

### 4.7 Claude Code

`metro claude [args…]` is the whole integration, and `metro bedrock` folds into it:

1. Start the daemon if it is not running.
2. Ensure the MCP server is registered at user scope in the agent's own Claude profile, loopback endpoint, current key, and the agent's connectors registered beside it (directly when unlinked, through the relay when linked).
3. Apply `provider.json`: first-party as-is; Bedrock through the loopback proxy with preflight, learned repairs persisted, and a plain statement of what is unsupported.
4. Set `CLAUDE_CONFIG_DIR=<agent>/claude` and `CLAUDE_CODE_PROJECT_DIR_NAME=<agent>`.
5. Add the channel flag and exec `claude` with every argument passed through verbatim.

### 4.8 Linked mode and metro.box

- Plaintext in Postgres: agent id and name, station rows as `(station, account_id, allowlist, handle)`, `agent_connectors`, connector rows (url, name, tool catalog, OAuth state, as today), the bundle index, the lease. That is what the dashboard, scoping, the relay and the webhook station need.
- Ciphertext: every movable station's `config`. It leaves the `stations` table and lives only in the bundle. Connector vendor credentials stay server-side because the relay injects them; that is the relay's whole point and is unchanged.
- Webhook stays hosted and plaintext, because metro runs it and generates its secret.
- SIWE only, Google is gone. The address that unlocks the agent owns the project.
- `link` registers a locally created agent id with the server ("adopt id"; ids are 64-bit random, collisions rejected). `unlink --export` pulls a hosted agent into a local bundle.

### 4.9 The local UI

The same React app that serves metro.box is served by the local daemon, from the static build shipped inside the CLI's runtime, on the daemon's own port. API calls are same-origin, so there is no CORS and no hosted session. The app learns which mode it is in from `/api/mode` and hides what does not apply locally (projects, members, Google sign-in, the relay's OAuth pages); everything agent-centric is the same code.

Bootstrap and sign-in

- `metro ui` prints a one-time URL carrying a token the daemon minted (the Jupyter pattern). That is the only way in before the agent has an owner.
- Once `init` has recorded the owner address, sign-in is SIWE against the local daemon: the wallet signs a nonce, the daemon verifies it with `viem`, and the address must match `agent.json`. The same identity that owns the agent on metro.box opens it locally, and the token URL is no longer needed.

Reaching it from another computer

- **Laptop: an SSH tunnel.** `ssh -L 8420:127.0.0.1:8420 user@server`, then `http://localhost:8420`. The daemon keeps binding loopback, the path is encrypted and authenticated by the SSH key, and nothing new runs anywhere. This is the default the docs teach.
- **Phone, or no SSH:** `metro ui --public` starts the `cloudflared` tunnel the daemon already has and prints an https URL. Open it in MetaMask's in-app browser and the injected provider is right there. Tailscale, where present, is the same shape without the tunnel.

Signing in the browser and handing keys to the daemon

The browser derives the keys itself (WebCrypto has HKDF) after `eth_signTypedData_v4` on the schema in 4.2, so the wallet flow is a normal dapp flow. The derived keys then have to reach the daemon, and on the tunnel path Cloudflare terminates TLS and would see them. So the daemon holds an ephemeral ECDH P-256 keypair from startup, the page it serves carries the public key, and the browser encrypts the derived keys to it (ECDH + AES-GCM, both in WebCrypto) before posting. Over the SSH tunnel that is belt and braces; over the public tunnel it is what makes the phone flow safe. `metro ui` prints the daemon's key fingerprint and the page shows it, so a user on a public path can compare them the way SSH host keys are compared.

What this removes: the WalletConnect client from the CLI, a QR renderer in the terminal, and the whole "sign on your phone for a headless box" problem, which becomes "open the box's UI on your phone".

### 4.10 Sharing an agent with another wallet

Access to an agent is "can unwrap the DEK", and it is binary: whoever can open the bundle can do everything the agent can. Project roles keep governing the plaintext side (dashboard, deleting the agent); unlocking is governed by the recipients list.

- **Grant.** The owner, or any current recipient, opens the agent (unwraps the DEK with their own private key), wraps it to the new member's registered public key, and publishes the new header. Metro stores wrapped keys and never sees the DEK. In the UI this is an Access section on the agent page: add by address or ENS name, which resolves to the public key that wallet registered when it first signed in. In the CLI it is `metro access add <address|ens>`, with `--public-key` for the unlinked case where there is no profile to look up.
- **Revoke.** Remove the recipient and rotate the DEK: the next snapshot is encrypted under a new DEK wrapped only for the remaining wallets. Snapshots the removed wallet already downloaded stay readable to it, which is true of every end-to-end system; if the concern is real, rotate the station tokens inside as well. `metro access remove` says so.
- **Precondition.** A wallet can only be granted access once it has registered a public key, which happens the first time it signs in anywhere with a wallet. Granting to an address that never has prints that instead of failing silently.
- The lease is unchanged: any number of wallets may be able to open an agent, and still exactly one machine runs it.

## 5. CLI surface

| Command | Does |
|---|---|
| `metro init [name]` | Create an agent here. Wallet signature (QR), keys derived, directory written. |
| `metro add <station> …` / `metro remove <station>` | Attach or detach a chat. Token flags for bots, QR in the terminal for whatsapp, pairing prompts for telegram-user, key derivation for xmtp. Verified before written. |
| `metro tools add <name> <url>` / `remove` / `list` | The agent's connectors. Direct registration when unlinked; relay when linked. |
| `metro claude [args…]` | See 4.7. |
| `metro status` / `logs [-f]` / `tail` | Daemon, events. `tail` is JSON lines, unchanged. |
| `metro provider anthropic\|bedrock …` | Inference profile, with preflight. |
| `metro export [--copy] [--include-sessions]` / `metro import <agent\|file>` | Portability. `import` reads metro.box when linked, a file when given a path. |
| `metro link` / `metro unlink [--export]` | Attach to or leave a metro.box project. |
| `metro sync` | Force a snapshot upload. Otherwise automatic. |
| `metro service install\|uninstall` | systemd (Linux) or launchd (macOS), running as the owning user. |
| `metro doctor` | Prerequisites, ownership, daemon, registration, provider, channel gate, key fingerprint. Each finding prints its fix. |
| `metro access add <address\|ens>` / `remove` / `list` | Who can unlock this agent. `remove` rotates the DEK. |
| `metro ui [--public]` | Prints the local UI's one-time URL; `--public` also opens the `cloudflared` tunnel and prints the daemon's key fingerprint. |
| `metro update`, `metro --version` | As today, with `latest` moved so `npm i -g` works. |
| `metro send <chat> <text>` / `metro react` | Thin wrappers over the daemon's call route, for scripts and agents without MCP. |

No positional agent ids anywhere. `--agent <name>` when a machine hosts more than one. `--json` on everything. Exit codes: 0 ok, 1 failed, 2 not initialised or not paired.

Removed: `start`/`stop` as daily commands (they become `service` and auto-start), `bedrock`, `plugin`, `login`/`logout`/`whoami`/`mcp` at top level, `version` as a subcommand.

## 6. Server changes

- Phase 0 (**done**): `agent_connectors`, the collection tables dropped, one code endpoint per agent, `typ: 'agent'` tokens, run tokens accepted on the relay, agent connector routes under `/api/agents/<id>/connectors`, per-agent name uniqueness.
- `bundles` table and the two bundle routes.
- `stations.config` emptied for movable stations after migration; a per-station `handle` column for the dashboard.
- SIWE sign-in, and `users.encryption_public_key` registered from the wallet's first sign-in.
- Bundle headers carry the recipients list; a header may be republished without a new ciphertext (grant), and the DEK rotation on revoke is a normal snapshot.
- Adopt-id on link.
- `/api/run/config` returns the bundle pointer instead of plaintext credentials; `httpSource` becomes download + decrypt + materialize.

## 7. Security model

What metro sees: that an agent exists, its stations' types and handles, its connectors and their vendor credentials (unchanged; the relay needs them), bundle sizes and versions, who holds the lease, the webhook secret it generated itself. What it never sees: any station token, agent key material, session, memory or signature.

Threats and mitigations

- Signature phishing: any site that gets the wallet to sign the exact typed data gets the key. Domain-bound EIP-712 with a readable purpose, rendered by the wallet. The accepted trade-off XMTP v2 made; documented plainly.
- Wallet compromise: total for every agent that wallet can open, since one signature reproduces its keypair. Recommend a dedicated wallet; the optional passphrase factor.
- Revocation is forward-only: a removed wallet keeps what it already downloaded. DEK rotation protects everything after.
- Machine compromise while running: the cached key and station credentials are readable, as today. Rotate keys and tokens.
- Postgres compromise: station ciphertext, connector credentials as today, metadata.
- A leaked agent token: that agent's connectors, nothing else. A leaked run token: also the lease, revoked from the agent page.
- Relay (WalletConnect) compromise: ciphertext only.

## 8. Migration

- Collections: Internal moves onto Tony, the rest are dropped with their connectors kept (section 3). One-way, with a backup.
- Existing hosted agents' station credentials: on the first run of a new-CLI daemon, `httpSource` pulls plaintext config, writes the local bundle, uploads it encrypted, and the server empties `stations.config` for that agent. One-way; run with a backup and a flag day.
- Suzy: `metro unlink --export` produces the bundle; the box is then self-contained and the bundle is what moves to any other server.
- Old commands survive as hidden aliases for two releases and print the new spelling.

## 9. Phases

Each phase ships behind the gate and has one acceptance test that a person can run.

0. **Agents own connectors.** Everything in section 3, server and UI in one PR so a deploy never leaves the UI pointing at deleted routes.
   Acceptance: attach a connector from Suzy's page; `metro login` authorizes Suzy; the relay serves that connector and refuses one not on her list; no Collections page anywhere.
1. **Local mode.** Agent directory, `fileSource`, admin socket, `init`/`add`/`remove`/`tools`/`status`/`logs`/`tail`/`claude`/`doctor`, ids gone. Interim key: derived from a pasted signature (no WalletConnect yet), so only one key scheme ever exists.
   Acceptance: fresh Ubuntu, four commands, a Telegram DM answered, no metro.box account involved.
2. **Portability.** Bundle format, `export`/`import` from a file, `lease.json`, Claude profile inside the agent.
   Acceptance: move Suzy (whatsapp + telegram-bot + connectors) between two servers; the old one refuses to start; memory intact.
3. **Cloud sync and linked mode.** `bundles` table and routes, `link`/`unlink`, automatic snapshots, `import <agent>` from the cloud, SIWE, encrypted-config migration.
   Acceptance: `metro import suzy` on a fresh box with nothing but the wallet.
4. **Wallet UX in the local UI, and sharing.** `metro ui`, `/api/mode`, SIWE against the daemon, the browser-side derivation and the ECDH handoff, `--public` over `cloudflared`, double-sign check, fingerprint errors, derived XMTP identity. `init` and `import` become "open this URL"; the paste fallback stays. `metro access` and the Access section, with DEK rotation on revoke.
   Acceptance: `init` on a server completed from a phone in MetaMask's browser over `--public`, and from a laptop over an SSH tunnel, with no pasting in either.
5. **Distribution.** Single-binary spike (`bun build --compile` with the native XMTP and SQLite bindings), install script, `service install`, `latest` tag moved.
   Acceptance: one `curl` on a bare machine; `doctor` reports nothing to fix.

Sizes: 0 large but mechanical, 1 large, 2 medium, 3 medium, 4 medium, 5 spike then medium.

## 10. Spikes and open questions

- Single binary with native addons under Bun. Decides whether install is one curl or stays `npm`.
- WebCrypto coverage for the browser-side derivation and ECDH handoff across the browsers people actually use, MetaMask mobile's in-app browser included.
- Shipping the UI build inside the CLI runtime: size, and how a local build learns its mode.
- Consistent SQLite snapshots of the live XMTP database from the daemon.
- `cloudflared` for local webhooks: works in principle, untested here.
- Whether a keychain-stored key may stand in for the wallet signature on machines that have one.
- X25519 in the browser: WebCrypto support is uneven (MetaMask mobile's WebView included), so the likely answer is `@noble/curves` on both sides, which the daemon side can share with `viem`'s own dependency.
- Bundle growth: three versions at up to 64 MiB each per agent is fine at beta scale; revisit the store only if that stops being true.

## 11. Already shipped that this builds on

- `metro bedrock` (0.1.0-beta.30): the loopback Messages-API → Bedrock proxy that gives Channels on Bedrock, with learned repairs for fields Bedrock rejects. Folds into `metro claude` via `provider.json`.
- The paste-ready command always names the local daemon.
- The socket-injector experiment, removed; not to be reintroduced.
