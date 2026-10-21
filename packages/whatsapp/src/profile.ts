import { jidNormalizedUser, type WASocket } from 'baileys';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { nonEmpty, type SenderProfile } from '@metro-labs/core/stations/sender-profile';
import { phoneOf, type NameBook } from './names.js';

export const NO_PICTURE_MS = 6 * 60 * 60_000;
export const RATE_LIMITED_MS = 30 * 60_000;
export const LOOKUP_BUDGET_MS = 6_000;
export const PROFILE_READS = 4;
const TRY_MS = 1_500;
const NO_PICTURE_MAX = 2_000;
const REFUSED = new Set([401, 403, 404]);
const RATE_LIMIT_RE = /rate.?over.?limit|too many/i;
const PICTURE_TYPES = ['image', 'preview'] as const;

type ProfileSocket = Pick<WASocket, 'fetchStatus' | 'profilePictureUrl' | 'signalRepository'>;

export interface PeerProfile {
  profile: SenderProfile;
  other: string | null;
}

export class PictureMemory {
  private none = new Map<string, number>();
  private limitedAt: number | null = null;

  constructor(readonly now: () => number = Date.now) {}

  known(jid: string): boolean {
    const at = this.none.get(jid);
    if (at === undefined) return false;
    if (this.now() - at < NO_PICTURE_MS) return true;
    this.none.delete(jid);
    return false;
  }

  remember(jid: string): void {
    this.none.delete(jid);
    this.none.set(jid, this.now());
    if (this.none.size <= NO_PICTURE_MAX) return;
    const oldest = this.none.keys().next();
    if (!oldest.done) this.none.delete(oldest.value);
  }

  limited(): boolean {
    return this.limitedAt !== null && this.now() - this.limitedAt < RATE_LIMITED_MS;
  }

  limit(): void {
    this.limitedAt = this.now();
  }
}

type Failure = 'refused' | 'limited' | 'other';

function failureOf(err: unknown): Failure {
  const output = isRecord(err) && isRecord(err.output) ? err.output : {};
  const code = typeof output.statusCode === 'number' ? output.statusCode : undefined;
  if (code === 429 || RATE_LIMIT_RE.test(errMsg(err))) return 'limited';
  return code !== undefined && REFUSED.has(code) ? 'refused' : 'other';
}

function within<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
  });
  return Promise.race([work.catch(() => fallback), late]).finally(() => {
    clearTimeout(timer);
  });
}

async function otherIdOf(sock: ProfileSocket, jid: string): Promise<string | null> {
  const mapping = sock.signalRepository.lidMapping;
  const other = await within(jid.endsWith('@lid') ? mapping.getPNForLID(jid) : mapping.getLIDForPN(jid), TRY_MS, null);
  return other === null ? null : jidNormalizedUser(other);
}

type Tried = { url: string } | 'none' | 'stop';

async function pictureFor(sock: ProfileSocket, jid: string, memory: PictureMemory, deadline: number): Promise<Tried> {
  for (const type of PICTURE_TYPES) {
    const left = deadline - memory.now();
    if (left <= 0) return 'stop';
    try {
      const url = nonEmpty(await sock.profilePictureUrl(jid, type, Math.min(TRY_MS, left)));
      if (url !== undefined) return { url };
    } catch (err) {
      const failure = failureOf(err);
      if (failure === 'limited') memory.limit();
      if (failure !== 'refused') return 'stop';
    }
  }
  memory.remember(jid);
  return 'none';
}

export async function pictureOf(sock: ProfileSocket, jids: string[], memory: PictureMemory, deadline = memory.now() + LOOKUP_BUDGET_MS): Promise<string | undefined> {
  for (const jid of jids) {
    if (memory.limited()) return undefined;
    if (memory.known(jid)) continue;
    const tried = await pictureFor(sock, jid, memory, deadline);
    if (tried === 'stop') return undefined;
    if (tried !== 'none') return tried.url;
  }
  return undefined;
}

export async function readPeer(sock: ProfileSocket, jid: string, memory: PictureMemory): Promise<PeerProfile> {
  const deadline = memory.now() + LOOKUP_BUDGET_MS;
  const other = await otherIdOf(sock, jid);
  const jids = other === null ? [jid] : [jid, other];
  const [statuses, picture] = await Promise.all([within(sock.fetchStatus(jid), LOOKUP_BUDGET_MS, undefined), pictureOf(sock, jids, memory, deadline)]);
  const status: unknown = statuses?.[0]?.status;
  const about = nonEmpty(isRecord(status) ? status.status : undefined);
  const phone = phoneOf(jid.endsWith('@lid') ? other : jid);
  return {
    other,
    profile: {
      id: jid,
      ...(phone === undefined ? {} : { name: phone, address: phone }),
      ...(about === undefined ? {} : { about }),
      ...(picture === undefined ? {} : { avatar: picture }),
    },
  };
}

export function withName(peer: PeerProfile, names: NameBook): SenderProfile {
  const { profile, other } = peer;
  if (other !== null) names.alias(profile.id.endsWith('@lid') ? other : profile.id, profile.id.endsWith('@lid') ? profile.id : other);
  const name = names.get(profile.id) ?? (other === null ? undefined : names.get(other));
  return name === undefined ? profile : { ...profile, display_name: name };
}

export function limiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= max)
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    else active += 1;
    try {
      return await run();
    } finally {
      release();
    }
  };
}
