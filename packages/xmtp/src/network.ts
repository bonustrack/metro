import { errMsg } from '@metro-labs/core/log';
import { TrainError } from '@metro-labs/core/train-error';

const RATE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 300_000;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function retryAfter(error: unknown, now: number): number {
  const fields = recordOf(error);
  if (typeof fields.retryAfterMs === 'number' && Number.isFinite(fields.retryAfterMs))
    return Math.max(0, fields.retryAfterMs);
  const headers = fields.headers ?? recordOf(fields.response).headers ?? fields.metadata;
  const get = recordOf(headers).get;
  const raw: unknown = typeof get === 'function' ? get.call(headers, 'retry-after') : recordOf(headers)['retry-after'];
  return retryDelay(Array.isArray(raw) ? raw[0] : raw, now);
}

function retryDelay(value: unknown, now: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function rateLimited(error: unknown): boolean {
  const fields = recordOf(error);
  return fields.code === 8 || fields.code === 429 || fields.status === 429 ||
    /resource.?exhausted|resource has been exhausted|exceeds rate limit|\b429\b/i.test(errMsg(error));
}

export class NetworkBackoff {
  private until = 0;
  private delay = RATE_DELAY_MS;
  private reason = '';

  constructor(private readonly now: () => number = Date.now) {}

  remaining(): number {
    return Math.max(0, this.until - this.now());
  }

  note(error: unknown): void {
    if (!rateLimited(error)) return;
    const now = this.now();
    if (now < this.until) {
      this.until = Math.max(this.until, now + retryAfter(error, now));
      return;
    }
    if (now - this.until >= MAX_DELAY_MS) this.delay = RATE_DELAY_MS;
    this.until = now + Math.max(this.delay, retryAfter(error, now));
    this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    this.reason = errMsg(error);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const remaining = this.remaining();
    if (remaining > 0)
      throw new TrainError('xmtp_rate_limited', `XMTP is rate limited; retry in ${Math.ceil(remaining / 1000)}s. ${this.reason}`, {
        retryable: true, retryAfterMs: remaining,
      });
    try {
      return await task();
    } catch (error) {
      this.note(error);
      throw error;
    }
  }
}

export const network = new NetworkBackoff();

export class SyncRequests {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new WeakMap<object, Map<string, Promise<unknown>>>();

  constructor(
    private readonly backoff: NetworkBackoff = network,
    private readonly now: () => number = Date.now,
  ) {}

  run(owner: object, id: string, task: () => Promise<unknown>): Promise<unknown> {
    let requests = this.pending.get(owner);
    if (!requests) {
      requests = new Map();
      this.pending.set(owner, requests);
    }
    const previous = requests.get(id);
    if (previous) return previous;
    const queuedAt = this.now();
    const run = () => {
      if (this.now() - queuedAt >= 30_000)
        throw new TrainError('xmtp_sync_busy', 'XMTP sync waited 30s; retry the request.', { retryable: true });
      return this.backoff.run(task);
    };
    const pending = this.tail.then(run, run).finally(() => { requests.delete(id); });
    requests.set(id, pending);
    this.tail = pending;
    return pending;
  }
}

const syncs = new SyncRequests();

export function syncConversation(owner: object, conv: { id: string; sync: () => Promise<unknown> }): Promise<unknown> {
  return syncs.run(owner, conv.id, () => conv.sync());
}

export function syncConversations(source: { sync: () => Promise<unknown> }): Promise<unknown> {
  return syncs.run(source, 'directory', () => source.sync());
}
