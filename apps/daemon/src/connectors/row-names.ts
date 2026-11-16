import { errMsg, log } from '@metro-labs/core/log';
import { isSlugSegment } from '@metro-labs/core/route-segments';
import type { AgentKey } from './agent-key.js';
import { agentCall, MetroApiRefusal, type MetroApi } from './metro-api.js';

const SESSION_PATH = '/api/agents/session';
const EVERY_MS = 15 * 60_000;
const NAME_MAX = 120;

export interface RowNames {
  server: string;
  organization: string;
  organizationSlug: string | null;
  agentSlug: string | null;
  agentName: string | null;
}

export interface RowNamesDeps {
  owner: () => string | null;
  key: () => AgentKey | null;
  api: MetroApi;
}

interface Expected {
  keyId: string;
  server: string;
  organization: string;
}

let kept: RowNames | null = null;

export const rowNames = (): RowNames | null => kept;

const slugOf = (raw: unknown): string | null => (typeof raw === 'string' && isSlugSegment(raw) ? raw : null);

function nameOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, NAME_MAX).trim();
  return name === '' ? null : name;
}

function rowNamesOf(answer: Record<string, unknown>, expected: Expected): RowNames | null {
  if (answer.server !== expected.server || answer.organization !== expected.organization || answer.keyId !== expected.keyId) return null;
  return { server: expected.server, organization: expected.organization, organizationSlug: slugOf(answer.organizationSlug), agentSlug: slugOf(answer.agentSlug), agentName: nameOf(answer.agentName) };
}

export function noteRowNames(answer: Record<string, unknown>, expected: Expected): void {
  const names = rowNamesOf(answer, expected);
  if (names !== null) kept = names;
}

const keyMissing = (err: unknown): boolean => err instanceof MetroApiRefusal && err.upstreamStatus === 401 && err.code === 'agent_key_missing';

export class RowNamesWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failure: string | null = null;

  constructor(private readonly deps: RowNamesDeps) {}

  async refresh(): Promise<void> {
    const key = this.enrolledKey();
    const enrollment = key?.enrollment ?? null;
    if (key === null || enrollment === null) {
      kept = null;
      return;
    }
    try {
      const expected = { keyId: key.keyId, server: enrollment.server, organization: enrollment.organization };
      const names = rowNamesOf(await agentCall(this.deps.api, key, SESSION_PATH), expected);
      if (names === null) throw new Error('api.metro.box answered for another agent');
      kept = names;
      if (this.failure !== null) log.info('row-names: the names of this agent on metro.box are read again');
      this.failure = null;
    } catch (err) {
      this.failed(err);
    }
  }

  start(everyMs = EVERY_MS): void {
    if (this.timer !== null) return;
    const tick = (): void => {
      this.refresh().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'row-names: the names of this agent on metro.box could not be read');
      });
    };
    tick();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private enrolledKey(): AgentKey | null {
    try {
      const key = this.deps.key();
      const owner = this.deps.owner();
      return key !== null && owner !== null && key.enrollment?.organization === owner ? key : null;
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'row-names: the agent key could not be read');
      return null;
    }
  }

  private failed(err: unknown): void {
    const said = errMsg(err);
    if (keyMissing(err)) kept = null;
    if (this.failure !== said) log.warn({ err: said, kept: kept !== null }, keyMissing(err) ? 'row-names: api.metro.box no longer knows this agent key, so approval links name the ids' : 'row-names: the names of this agent on metro.box could not be read, so the last ones stand');
    this.failure = said;
  }
}

let shared: RowNamesWatch | null = null;

export function watchRowNames(deps: RowNamesDeps, everyMs = EVERY_MS): RowNamesWatch {
  shared?.stop();
  shared = new RowNamesWatch(deps);
  shared.start(everyMs);
  return shared;
}

export function stopRowNames(): void {
  shared?.stop();
}
