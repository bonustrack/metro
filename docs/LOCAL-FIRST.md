# Local first

*Decided with Less on 2026-09-04.*

## The shape

The machine is the product. `metro serve` runs a daemon that owns its agents outright:
the agent files, the channel credentials, the connectors with their OAuth tokens, and the
relay to every connector's vendor. Claude Code on that machine talks to that daemon and to
nothing else. The web page at metro.box is a static page that talks to **one local daemon**,
over loopback or over the daemon's tunnel; there is no hosted mode in the page and no
"switch daemon" between hosted and local, only the address of the daemon it manages.

metro.box keeps exactly two things per wallet:

- **the list of agents**: id, name, channel kinds, last sync time, nothing that opens anything;
- **a vault**: one ciphertext blob per agent holding the agent file, its channels' credentials
  and its connectors' credentials, sealed so that only the wallet that owns the agent can open it.

Sealing and opening happen **in the browser**. The wallet signs one EIP-712 message once; the
page derives the wallet's X25519 key pair from that signature and never sends it anywhere. Each
agent has a random data key; the bundle is AES-256-GCM under it, and the data key is wrapped to
the wallet's public key. A daemon holds plaintext for the machine it runs on and nothing else;
metro.box holds ciphertext and the wrapped key and cannot open either.

**Sync with Metro** on the local page reads the agent's bundle from the daemon, seals it, and
pushes it. **Restore** on a fresh machine lists the wallet's agents from metro.box, downloads
one, opens it in the browser, and hands the plaintext to that machine's daemon, which writes
the files and starts the channels. The same id and key carry over, so the `claude mcp add`
line does not change.

## What goes

- Teams: projects, members and project settings. The vault is per wallet.
- `metro start` and the runtime lease: every box runs `metro serve`; an agent reaches a new
  box by restore, not by a pull from metro.box.
- Plaintext channel rows and connectors on metro.box, and the hosted relay. Once every agent
  has been synced and restored, those tables and routes are deleted.
- The import from metro.box, replaced by restore.

## What stays hosted

- Sign-in with the wallet, because the vault is keyed by it.
- **Inbound webhooks**, the one channel that needs a stable public address providers can be
  given. metro.box keeps the endpoint and forwards each delivery to the agent's daemon; how
  the daemon receives it (an outbound subscription, or a push over its tunnel) is decided with
  that slice.

## Order

1. **Local connectors.** Add, edit, remove, verify and sign in to connectors on the local
   daemon, OAuth landing on the daemon's own public base (loopback or tunnel), the relay to
   the vendor running from the daemon, `metro mcp` pointing Claude Code at the local daemon.
   metro.box is off the connector path from here on.
2. **Page local-only.** Remove hosted mode, *Switch daemon*, projects, members and project
   settings from the page; the connect card only chooses which local daemon.
3. **Vault and Sync.** The vault routes on metro.box, browser-side sealing, *Sync with Metro*
   and *Restore*. Shipped 2026-09-04 (`0021_vault`, `/api/vault`, `/api/agents/<id>/bundle`,
   `/api/agents/restore`, `apps/ui/src/vault/`).
4. **Retire the hosted paths** named above, after the agents have moved. Shipped 2026-09-04
   (`0022_local_only`): metro.box keeps `users` and `vault`; `metro start`, the leases, the
   pairing codes, the hosted relay, the import and the project and member APIs are gone, the
   CLI is `serve`/`stop`/`tail`/`whoami`/`mcp`/`plugin`/`claude`/`bedrock`/`update`, and the
   plugin reads the local daemon. Webhooks wait for the forwarding slice.

Each step ships on its own and leaves a working product.

## Keys

Two layers, so an agent can be opened by more than one wallet.

**A wallet has one deterministic encryption keypair**, derived from a single EIP-712 signature
that is the same for every agent the wallet touches. These values sit in every wrapped key and
must not change:

```
domain:  { name: "metro", version: "1" }
types:   EncryptionKey { purpose: string, keyVersion: uint256 }
message: { purpose: "encryption-key", keyVersion: 1 }
```

`HKDF-SHA256(ikm = signature bytes, salt = "metro", info = "secp256k1", 48 bytes)` mapped to a
scalar is the wallet's secp256k1 private key (Ethereum's curve, the ECIES shape XMTP used for its
wallet-derived key bundles). Nothing has to be recovered: the same signature reproduces the
keypair anywhere. Since 2026-09-04 that one signature is also the sign-in: the page keeps it in
the browser, derives a second secp256k1 key from it (`info = "vault-secp256k1"`) and signs every
request to the local daemon and to the vault with that identity, so a wallet is prompted once per
browser, not once per action.

**An agent has one random data key (DEK)**, minted at every sync. The bundle is AES-256-GCM
under it, and the DEK is wrapped to the wallet's public key (ephemeral secp256k1 ECDH, HKDF,
AES-256-GCM). The wrapped keys travel in the bundle header in the clear and are useless without
the matching private key.

- EOAs only. The wallet signs once per browser; a non-deterministic signer (ERC-1271 contract
  wallets, some MPC wallets) derives another key at restore and fails by name, never silently.
- Each wrapped key records the recipient's address and public key, so the wrong wallet fails
  with "this wallet does not unlock this agent", never a decryption error.
- Rotating a wallet keypair bumps `keyVersion`: the wallet re-signs and every agent it can open
  is re-wrapped. Rotating a DEK re-encrypts at the next sync.
- The signature is taken in the page with the wallet the browser already has and never reaches
  metro's servers.
