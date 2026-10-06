import { timingSafeEqual } from 'node:crypto';
import { ticketStore, type TicketStore } from '@metro-labs/core/tickets';
import { pkcePair, type FetchLike, type Tokens } from '@metro-labs/core/stations/oauth';
import type { Session } from '@metro-labs/http/workos-token';
import type { ServerEntry } from '../server-types.js';
import type { GmailConfig } from './config.js';
import { gmailStartAdmission } from './admission.js';
import { issueGmailGrant, readGmailGrant, type GmailIdentity } from './grants.js';
import { GmailError, inputAgent, inputChallenge, inputHost, inputMailbox, inputObject, inputText, inputVerifier, staleState } from './input.js';
import { exchangeGmailCode, gmailAuthorizeUrl, gmailProfile, refreshGmailTokens, revokeGmailToken } from './provider.js';

export type GmailSession = Session & { organization: string };

export interface GmailState {
  organization: string;
  userId: string;
  sessionId: string;
  serverId: string;
  host: string;
  agentId: string;
  challenge: string;
  mailbox: string | null;
  sendEnabled: boolean;
}

export interface GmailBrokerDeps {
  config: () => GmailConfig | null;
  states: TicketStore<GmailState>;
  fetch: FetchLike;
  list: (organization: string) => Promise<Pick<ServerEntry, 'id' | 'host'>[]>;
  allowed: (userId: string, organization: string) => Promise<boolean>;
  now: () => number;
}

interface GmailTokens extends Tokens {
  accountEmail: string;
  refreshGrant: string;
  sendEnabled: boolean;
  managed: true;
  managedHost: string;
}

export function gmailStateStore(): TicketStore<GmailState> {
  const max = 1000;
  const states = ticketStore<GmailState>(10 * 60_000, max);
  return {
    ...states,
    mint(value, now = Date.now()) {
      if (states.size(now) >= max) throw new GmailError('Gmail sign-in is busy. Try again in ten minutes.', 503);
      return states.mint(value, now);
    },
  };
}

export class GmailBroker {
  private readonly admitStart = gmailStartAdmission();

  constructor(private readonly deps: GmailBrokerDeps) {}

  available(): boolean {
    return this.deps.config() !== null;
  }

  private config(): GmailConfig {
    const config = this.deps.config();
    if (config === null) throw new GmailError('Managed Gmail sign-in is not configured.', 503);
    return config;
  }

  private async authorize(userId: string, organization: string): Promise<void> {
    if (!await this.deps.allowed(userId, organization)) throw new GmailError('This account can no longer connect Gmail for this organization.', 403);
  }

  private async server(organization: string, host: string, serverId?: string): Promise<string> {
    const found = (await this.deps.list(organization)).find((row) => row.host === host && (serverId === undefined || row.id === serverId));
    if (found === undefined) throw new GmailError('This server is no longer saved in this organization. Connect Gmail again.', 403);
    return found.id;
  }

  private async current(identity: Pick<GmailIdentity, 'organization' | 'userId' | 'host' | 'serverId'>): Promise<void> {
    await this.authorize(identity.userId, identity.organization);
    await this.server(identity.organization, identity.host, identity.serverId);
  }

  private take(body: Record<string, unknown>, session: GmailSession): GmailState {
    const ticket = inputText(body.state, 128);
    const now = this.deps.now();
    const state = this.deps.states.peek(ticket, now);
    if (state === undefined) throw staleState();
    const actor = state.userId === session.userId && state.organization === session.organization && state.sessionId === session.sessionId;
    if (!actor || state.host !== body.host || state.agentId !== body.agentId) throw staleState();
    const consumed = this.deps.states.take(ticket, now);
    if (consumed === undefined) throw staleState();
    return consumed;
  }

  async start(session: GmailSession, raw: unknown): Promise<{ state: string; authorizeUrl: string; expiresAt: number }> {
    const config = this.config();
    const body = inputObject(raw, ['host', 'agentId', 'challenge', 'mailbox', 'sendEnabled']);
    const host = inputHost(body.host);
    const agentId = inputAgent(body.agentId);
    const challenge = inputChallenge(body.challenge);
    const mailbox = inputMailbox(body.mailbox);
    if (typeof body.sendEnabled !== 'boolean') throw new GmailError('Choose whether Gmail sending is enabled.', 400);
    this.admitStart(session.userId, this.deps.now());
    await this.authorize(session.userId, session.organization);
    const serverId = await this.server(session.organization, host);
    const { ticket, expiresAt } = this.deps.states.mint({
      organization: session.organization, userId: session.userId, sessionId: session.sessionId,
      serverId, host, agentId, challenge, mailbox, sendEnabled: body.sendEnabled,
    }, this.deps.now());
    return { state: ticket, authorizeUrl: gmailAuthorizeUrl(config, ticket, challenge, mailbox, body.sendEnabled), expiresAt };
  }

  async exchange(session: GmailSession, raw: unknown): Promise<GmailTokens> {
    const config = this.config();
    const body = inputObject(raw, ['state', 'code', 'verifier', 'host', 'agentId']);
    const state = this.take(body, session);
    const verifier = inputVerifier(body.verifier);
    const challenge = pkcePair(verifier).challenge;
    if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(state.challenge))) throw staleState();
    const code = inputText(body.code, 4096);
    await this.current(state);
    const tokens = await exchangeGmailCode(this.deps.fetch, config, code, verifier, state.sendEnabled, this.deps.now);
    const email = await gmailProfile(this.deps.fetch, tokens.accessToken);
    if (state.mailbox !== null && email !== state.mailbox) throw new GmailError('Google signed in to a different mailbox. Nothing was connected.', 400);
    await this.current(state);
    return this.tokens({ ...state, email }, tokens, config);
  }

  cancel(session: GmailSession, raw: unknown): { cancelled: true } {
    this.take(inputObject(raw, ['state', 'host', 'agentId']), session);
    return { cancelled: true };
  }

  private credential(raw: unknown, config: GmailConfig, purpose: 'refresh' | 'revoke' = 'refresh'): { identity: GmailIdentity; refreshToken: string } {
    const body = inputObject(raw, ['refreshToken', 'refreshGrant', 'host']);
    const refreshToken = inputText(body.refreshToken, 8192);
    const grant = inputText(body.refreshGrant, 8192);
    const host = inputHost(body.host);
    return { identity: readGmailGrant(grant, refreshToken, host, config, this.deps.now(), purpose), refreshToken };
  }

  async refresh(raw: unknown): Promise<GmailTokens> {
    const config = this.config();
    const { identity, refreshToken } = this.credential(raw, config);
    await this.current(identity);
    const tokens = await refreshGmailTokens(this.deps.fetch, config, refreshToken, identity.sendEnabled, this.deps.now);
    await this.current(identity);
    return this.tokens(identity, tokens, config);
  }

  async revoke(raw: unknown): Promise<{ revoked: true }> {
    const { refreshToken } = this.credential(raw, this.config(), 'revoke');
    await revokeGmailToken(this.deps.fetch, refreshToken);
    return { revoked: true };
  }

  private tokens(identity: GmailIdentity, tokens: Tokens, config: GmailConfig): GmailTokens {
    return {
      ...tokens,
      accountEmail: identity.email,
      refreshGrant: issueGmailGrant(identity, tokens.refreshToken, config, this.deps.now()),
      sendEnabled: identity.sendEnabled,
      managed: true,
      managedHost: identity.host,
    };
  }
}
