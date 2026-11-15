import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const PUSH_BATCH_MAX = 100;
export const PUSH_TIMEOUT_MS = 10_000;
export const MEMBERS_TTL_MS = 60_000;
export const PUSH_CHANNEL = 'approvals';

const MEMBERS_HELD_MAX = 1000;
const GONE = 'DeviceNotRegistered';

export interface PushNote {
  title: string;
  body: string;
  url: string;
}

export interface PushDevices {
  tokensOf: (users: string[]) => Promise<string[]>;
  drop: (tokens: string[]) => Promise<number>;
}

export interface PushSenderDeps {
  fetch: FetchLike;
  accessToken: string | null;
  members: (owner: string) => Promise<string[]>;
  devices: PushDevices;
  now: () => number;
  endpoint?: string;
  timeoutMs?: number;
}

export interface PushOutcome {
  devices: number;
  sent: number;
  failed: number;
  dropped: number;
}

interface BatchResult {
  sent: number;
  failed: number;
  gone: string[];
}

const batchesOf = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, (at + 1) * size));

function messageOf(token: string, note: PushNote): Record<string, unknown> {
  return { to: token, title: note.title, body: note.body, data: { url: note.url }, channelId: PUSH_CHANNEL, priority: 'high', sound: 'default' };
}

function ticketsOf(answer: unknown): unknown[] {
  return isRecord(answer) && Array.isArray(answer.data) ? (answer.data as unknown[]) : [];
}

const goneTicket = (ticket: unknown): boolean => isRecord(ticket) && ticket.status === 'error' && isRecord(ticket.details) && ticket.details.error === GONE;

const okTicket = (ticket: unknown): boolean => isRecord(ticket) && ticket.status === 'ok';

export class PushSender {
  private readonly held = new Map<string, { users: string[]; at: number }>();

  constructor(private readonly deps: PushSenderDeps) {}

  async notify(owner: string, note: PushNote): Promise<PushOutcome> {
    const tokens = await this.deps.devices.tokensOf(await this.membersOf(owner));
    const outcome: PushOutcome = { devices: tokens.length, sent: 0, failed: 0, dropped: 0 };
    const gone: string[] = [];
    for (const batch of batchesOf(tokens, PUSH_BATCH_MAX)) {
      const result = await this.sendBatch(batch, note);
      outcome.sent += result.sent;
      outcome.failed += result.failed;
      gone.push(...result.gone);
    }
    if (gone.length > 0) outcome.dropped = await this.deps.devices.drop(gone);
    return outcome;
  }

  private async membersOf(owner: string): Promise<string[]> {
    const now = this.deps.now();
    const held = this.held.get(owner);
    if (held !== undefined && now - held.at < MEMBERS_TTL_MS) return held.users;
    const users = await this.deps.members(owner);
    this.held.delete(owner);
    this.held.set(owner, { users, at: now });
    if (this.held.size > MEMBERS_HELD_MAX) this.held.delete(this.held.keys().next().value ?? owner);
    return users;
  }

  private async sendBatch(tokens: string[], note: PushNote): Promise<BatchResult> {
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    if (this.deps.accessToken !== null) headers.authorization = `Bearer ${this.deps.accessToken}`;
    try {
      const res = await this.deps.fetch(this.deps.endpoint ?? EXPO_PUSH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(tokens.map((token) => messageOf(token, note))),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? PUSH_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn({ status: res.status, devices: tokens.length }, 'push: Expo refused a batch');
        return { sent: 0, failed: tokens.length, gone: [] };
      }
      const tickets = ticketsOf(await res.json().catch(() => null));
      const gone = tokens.filter((_, at) => goneTicket(tickets[at]));
      const sent = tickets.filter(okTicket).length;
      return { sent, failed: tokens.length - sent, gone };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.name : 'error', devices: tokens.length }, 'push: Expo could not be reached');
      return { sent: 0, failed: tokens.length, gone: [] };
    }
  }
}
