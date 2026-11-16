import type { IncomingMessage } from 'node:http';

const TRACKED_MAX = 5000;

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const first = typeof value === 'string' ? value.split(',')[0]?.trim() : '';
  return first === undefined || first === '' ? null : first;
}

export const clientAddress = (req: IncomingMessage): string => header(req, 'fly-client-ip') ?? header(req, 'cf-connecting-ip') ?? req.socket.remoteAddress ?? 'unknown';

export class RateLimit {
  private readonly tries = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  spend(key: string, now: number): boolean {
    const recent = (this.tries.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) return false;
    this.tries.delete(key);
    this.tries.set(key, [...recent, now]);
    while (this.tries.size > TRACKED_MAX) {
      const first = this.tries.keys().next().value;
      if (first === undefined) break;
      this.tries.delete(first);
    }
    return true;
  }
}
