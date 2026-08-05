import { randomBytes } from 'node:crypto';
import { ApiError } from './api-error.js';
import { errMsg, log } from './log.js';
import type { StationName } from '../db/schema.js';
import {
  startInteractiveAttach,
  type AttachDriver,
  type AttachOutcome,
  type AttachPrompt,
  type AttachStep,
  type DriverHooks,
  type InteractiveStation,
  type StartedAttach,
} from '../stations/attach-interactive.js';

export type StartAttach = (
  station: InteractiveStation,
  input: Record<string, unknown>,
  hooks: DriverHooks,
) => Promise<StartedAttach>;

export const ATTACH_ID_RE = /^as_[A-Za-z0-9_-]{22}$/;

const PENDING_TTL_MS = 5 * 60_000;
const SETTLED_TTL_MS = 60_000;
const SWEEP_MS = 15_000;
const MAX_PER_AGENT = 2;
const MAX_TOTAL = 40;

export interface AttachOwner {
  email: string;
  granted: string[];
  agentId: number;
}

export interface AttachView {
  attachId: string;
  station: string;
  status: 'pending' | 'done' | 'failed';
  step: AttachStep | null;
  prompt: string;
  qr: string | null;
  pairingCode: string | null;
  accountId: string | null;
  identity: Record<string, string>;
  activated: boolean;
  error: string | null;
  expiresAt: number;
}

export type CompleteAttach = (
  owner: AttachOwner,
  station: StationName,
  config: Record<string, unknown>,
) => Promise<{ accountId: string; activated: boolean }>;

export type AuthorizeAttach = (owner: AttachOwner) => Promise<void>;

export interface AttachSessionDeps {
  authorize: AuthorizeAttach;
  complete: CompleteAttach;
  start?: StartAttach;
}

interface Session {
  owner: AttachOwner;
  driver: AttachDriver | null;
  view: AttachView;
}

const missing = (): ApiError => new ApiError('no such attach session', 404);

function newAttachId(): string {
  return `as_${randomBytes(16).toString('base64url')}`;
}

function blankView(attachId: string, station: string): AttachView {
  return {
    attachId,
    station,
    status: 'pending',
    step: null,
    prompt: '',
    qr: null,
    pairingCode: null,
    accountId: null,
    identity: {},
    activated: false,
    error: null,
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
}

export class AttachSessions {
  private sessions = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: AttachSessionDeps) {}

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      this.sweep().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'attach-session: sweep failed');
      });
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  private own(owner: AttachOwner, attachId: string): Session {
    const session = this.sessions.get(attachId);
    if (
      session?.owner.email !== owner.email ||
      session.owner.agentId !== owner.agentId
    )
      throw missing();
    return session;
  }

  private admit(owner: AttachOwner): void {
    if (this.sessions.size >= MAX_TOTAL)
      throw new ApiError(
        'too many sign-ins are in flight on this daemon, try again shortly',
        429,
      );
    const mine = [...this.sessions.values()].filter(
      (s) => s.owner.agentId === owner.agentId && s.view.status === 'pending',
    );
    if (mine.length >= MAX_PER_AGENT)
      throw new ApiError(
        'this agent already has a sign-in in progress, finish or cancel it first',
        409,
      );
  }

  private settle(session: Session, patch: Partial<AttachView>): void {
    Object.assign(session.view, patch, {
      qr: null,
      pairingCode: null,
      step: null,
      expiresAt: Date.now() + SETTLED_TTL_MS,
    });
    session.driver = null;
  }

  private async finish(
    attachId: string,
    station: StationName,
    outcome: AttachOutcome,
  ): Promise<void> {
    const session = this.sessions.get(attachId);
    if (session?.view.status !== 'pending') return;
    try {
      const landed = await this.deps.complete(
        session.owner,
        station,
        outcome.config,
      );
      this.settle(session, {
        status: 'done',
        prompt: '',
        identity: outcome.identity,
        accountId: landed.accountId,
        activated: landed.activated,
      });
      log.info(
        { agentId: session.owner.agentId, station, account: landed.accountId },
        'attach-session: signed in and attached a station account',
      );
    } catch (err) {
      const reason =
        err instanceof ApiError ? err.message : 'could not store the account';
      log.warn({ station, err: errMsg(err) }, 'attach-session: store failed');
      this.settle(session, { status: 'failed', prompt: '', error: reason });
    }
  }

  private hooksFor(attachId: string, station: StationName) {
    return {
      prompt: (p: AttachPrompt): void => {
        const session = this.sessions.get(attachId);
        if (session?.view.status !== 'pending') return;
        session.view.step = p.step;
        session.view.prompt = p.prompt;
        session.view.qr = p.qr ?? null;
        session.view.pairingCode = p.pairingCode ?? null;
      },
      done: (o: AttachOutcome): void => {
        this.finish(attachId, station, o).catch((err: unknown) => {
          log.warn(
            { attachId, station, err: errMsg(err) },
            'attach-session: completion failed',
          );
        });
      },
      fail: (message: string): void => {
        const session = this.sessions.get(attachId);
        if (session?.view.status !== 'pending') return;
        this.settle(session, { status: 'failed', prompt: '', error: message });
      },
    };
  }

  async start(
    owner: AttachOwner,
    station: InteractiveStation,
    input: Record<string, unknown>,
  ): Promise<AttachView> {
    await this.deps.authorize(owner);
    this.admit(owner);
    this.ensureSweeper();
    const attachId = newAttachId();
    const session: Session = {
      owner,
      driver: null,
      view: blankView(attachId, station),
    };
    this.sessions.set(attachId, session);
    try {
      const started = await (this.deps.start ?? startInteractiveAttach)(
        station,
        input,
        this.hooksFor(attachId, station),
      );
      session.driver = started.driver;
      this.hooksFor(attachId, station).prompt(started.prompt);
    } catch (err) {
      this.sessions.delete(attachId);
      throw err;
    }
    log.info(
      { agentId: owner.agentId, station, attachId },
      'attach-session: started',
    );
    return { ...session.view };
  }

  view(owner: AttachOwner, attachId: string): AttachView {
    return { ...this.own(owner, attachId).view };
  }

  async submit(
    owner: AttachOwner,
    attachId: string,
    input: { code?: unknown; password?: unknown },
  ): Promise<AttachView> {
    const session = this.own(owner, attachId);
    const driver = session.driver;
    if (session.view.status !== 'pending' || !driver)
      throw new ApiError('this sign-in is already finished', 409);
    await driver.submit(input);
    return { ...session.view };
  }

  async cancel(owner: AttachOwner, attachId: string): Promise<void> {
    const session = this.own(owner, attachId);
    this.sessions.delete(attachId);
    await session.driver?.cancel().catch(() => undefined);
    log.info({ attachId }, 'attach-session: cancelled');
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const [attachId, session] of [...this.sessions]) {
      if (session.view.expiresAt > now) continue;
      this.sessions.delete(attachId);
      const driver = session.driver;
      session.driver = null;
      if (!driver) continue;
      log.info({ attachId }, 'attach-session: expired, credentials discarded');
      await driver.cancel().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await this.sweep(Number.MAX_SAFE_INTEGER);
  }
}
