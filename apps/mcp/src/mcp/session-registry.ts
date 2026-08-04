import { randomUUID } from 'node:crypto';
import { currentBusSeq } from '../daemon/events.js';
import { newReplayLedger, type ReplayLedger } from '../channels/relay.js';
import { McpSession, channelLog } from './session.js';
import { sessionScopeKey, type SessionOwnership } from './session-route.js';
import type { RequestIdentity } from './request-identity.js';

export const MAX_SESSIONS = 64;
export const SESSION_IDLE_MS = 10 * 60_000;
export const LEDGER_MAX = 256;
const SWEEP_MS = 60_000;

export class SessionCapacityError extends Error {
  constructor() {
    super('too many live MCP sessions');
  }
}

export class SessionRegistry {
  private readonly byId = new Map<string, McpSession>();
  private readonly byScope = new Map<string, McpSession>();
  private readonly ledgers = new Map<string, ReplayLedger>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly log: (...a: unknown[]) => void;
  private started = false;
  private floor = 0;

  constructor(log: (...a: unknown[]) => void = channelLog) {
    this.log = log;
    this.sweeper = setInterval(() => {
      this.sweep(Date.now());
    }, SWEEP_MS);
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.byId.size;
  }

  get(sessionId: string): McpSession | undefined {
    return this.byId.get(sessionId);
  }

  forScope(scopeKey: string): McpSession | undefined {
    return this.byScope.get(scopeKey);
  }

  ownership(
    presented: string | undefined,
    scopeKey: string,
  ): SessionOwnership {
    if (presented === undefined) return 'none';
    const found = this.byId.get(presented);
    if (!found) return 'none';
    return found.scopeKey === scopeKey ? 'mine' : 'theirs';
  }

  startInbound(): void {
    if (this.started) return;
    this.started = true;
    this.floor = currentBusSeq();
    for (const session of this.byId.values()) session.startChannel();
  }

  async create(
    identity: RequestIdentity,
    adoptId?: string,
  ): Promise<McpSession> {
    const scopeKey = sessionScopeKey(identity);
    const id = adoptId ?? randomUUID();
    await this.byScope.get(scopeKey)?.close();
    await this.byId.get(id)?.close();
    await this.makeRoom();
    const session = await McpSession.open({
      id,
      scopeKey,
      adopted: adoptId !== undefined,
      ledger: this.ledgerFor(scopeKey),
      onClosed: (s) => {
        this.forget(s);
      },
    });
    this.byId.set(id, session);
    this.byScope.set(scopeKey, session);
    if (this.started) session.startChannel();
    this.log('session: opened', 'id', id, 'scope', scopeKey, 'live', this.byId.size);
    return session;
  }

  async closeScope(scopeKey: string): Promise<boolean> {
    const session = this.byScope.get(scopeKey);
    if (!session) return false;
    this.log('session: closed, credential rotated', 'id', session.id, 'scope', scopeKey);
    await session.close();
    return true;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    for (const session of [...this.byId.values()]) await session.close();
    this.ledgers.clear();
  }

  sweep(now: number): number {
    let reaped = 0;
    for (const session of [...this.byId.values()]) {
      if (session.streamAttached) continue;
      if (now - session.lastSeenAt <= SESSION_IDLE_MS) continue;
      this.log('session: reaped idle', 'id', session.id, 'scope', session.scopeKey);
      void session.close();
      reaped += 1;
    }
    return reaped;
  }

  private forget(session: McpSession): void {
    if (this.byId.get(session.id) === session) this.byId.delete(session.id);
    if (this.byScope.get(session.scopeKey) === session)
      this.byScope.delete(session.scopeKey);
  }

  private async makeRoom(): Promise<void> {
    if (this.byId.size < MAX_SESSIONS) return;
    this.sweep(Date.now());
    if (this.byId.size < MAX_SESSIONS) return;
    const idle = [...this.byId.values()]
      .filter((s) => !s.streamAttached)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
      .at(0);
    if (!idle) throw new SessionCapacityError();
    await idle.close();
  }

  private ledgerFor(scopeKey: string): ReplayLedger {
    const found = this.ledgers.get(scopeKey);
    if (found) {
      this.ledgers.delete(scopeKey);
      this.ledgers.set(scopeKey, found);
      return found;
    }
    const fresh = newReplayLedger(this.started ? this.floor : currentBusSeq());
    this.ledgers.set(scopeKey, fresh);
    while (this.ledgers.size > LEDGER_MAX) {
      const oldest = this.ledgers.keys().next();
      if (oldest.done) break;
      this.ledgers.delete(oldest.value);
    }
    return fresh;
  }
}
