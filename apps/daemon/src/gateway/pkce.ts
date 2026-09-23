import { createHash, randomBytes } from 'node:crypto';

const PENDING_TTL_MS = 10 * 60_000;

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export class PendingLogins {
  private readonly pending = new Map<string, { verifier: string; at: number }>();

  constructor(private readonly stateBytes: number) {}

  private sweep(now: number): void {
    for (const [state, entry] of this.pending) if (now - entry.at > PENDING_TTL_MS) this.pending.delete(state);
  }

  begin(now: number): { state: string; challenge: string } {
    this.sweep(now);
    const { verifier, challenge } = newPkce();
    const state = b64url(randomBytes(this.stateBytes));
    this.pending.set(state, { verifier, at: now });
    return { state, challenge };
  }

  take(state: string, now: number): string | null {
    this.sweep(now);
    const entry = this.pending.get(state);
    if (entry === undefined) return null;
    this.pending.delete(state);
    return entry.verifier;
  }
}
