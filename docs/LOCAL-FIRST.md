# Local first

*Decided with Less on 2026-09-04. This replaces the "Phase 1" notes in `CLI-REDESIGN.md` for
what runs where; the encryption scheme there (one EIP-712 signature per wallet, X25519 keys,
a DEK per agent wrapped to the wallet) still holds and is used below.*

## The shape

The machine is the product. `metro serve` runs a daemon that owns its agents outright:
the agent files, the station credentials, the connectors with their OAuth tokens, and the
relay to every connector's vendor. Claude Code on that machine talks to that daemon and to
nothing else. The web page at metro.box is a static page that talks to **one local daemon**,
over loopback or over the daemon's tunnel; there is no hosted mode in the page and no
"switch daemon" between hosted and local, only the address of the daemon it manages.

metro.box keeps exactly two things per wallet:

- **the list of agents**: id, name, station kinds, last sync time, nothing that opens anything;
- **a vault**: one ciphertext blob per agent holding the agent file, its stations' credentials
  and its connectors' credentials, sealed so that only the wallet that owns the agent can open it.

Sealing and opening happen **in the browser**. The wallet signs one EIP-712 message once; the
page derives the wallet's X25519 key pair from that signature and never sends it anywhere. Each
agent has a random data key; the bundle is AES-256-GCM under it, and the data key is wrapped to
the wallet's public key. A daemon holds plaintext for the machine it runs on and nothing else;
metro.box holds ciphertext and the wrapped key and cannot open either.

**Sync with Metro** on the local page reads the agent's bundle from the daemon, seals it, and
pushes it. **Restore** on a fresh machine lists the wallet's agents from metro.box, downloads
one, opens it in the browser, and hands the plaintext to that machine's daemon, which writes
the files and starts the stations. The same id and key carry over, so the `claude mcp add`
line does not change.

## What goes

- Teams: projects, members and project settings. The vault is per wallet.
- `metro start` and the runtime lease: every box runs `metro serve`; an agent reaches a new
  box by restore, not by a pull from metro.box.
- Plaintext station rows and connectors on metro.box, and the hosted relay. Once every agent
  has been synced and restored, those tables and routes are deleted.
- The import from metro.box, replaced by restore.

## What stays hosted

- Sign-in with the wallet, because the vault is keyed by it.
- **Inbound webhooks**, the one station that needs a stable public address providers can be
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
   and *Restore*.
4. **Retire the hosted paths** named above, after the agents have moved.

Each step ships on its own and leaves a working product.
