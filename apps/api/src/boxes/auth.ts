import type { IncomingMessage } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { BOX_CLOCK_SKEW_MS, boxSignatureValid, readBoxProof, withinSkew, type BoxProof, type BoxRequest } from '@metro-labs/http/box-signature';

const NONCES_MAX = 200_000;
const NONCES_PER_KEY = 600;
const PRUNE_MS = 60_000;

export class BoxAuthError extends ApiError {}

export const notEnrolled = (): BoxAuthError => new BoxAuthError('This box is not enrolled with Metro, or its request signature is not valid.', 401);

export function refuseBrowser(req: IncomingMessage): void {
  const browser = Object.keys(req.headers).some((name) => name === 'origin' || name.startsWith('sec-fetch-'));
  if (browser) throw new BoxAuthError('Only a Metro box may call this, not a browser.', 403);
}

export const boxRequestOf = (req: IncomingMessage, body: Buffer): BoxRequest => ({
  method: req.method ?? '',
  host: req.headers.host ?? '',
  path: req.url ?? '',
  body,
});

interface Seen {
  keyId: string;
  until: number;
}

export class BoxAuth {
  private readonly nonces = new Map<string, Seen>();
  private readonly perKey = new Map<string, number>();
  private pruned = 0;

  constructor(private readonly now: () => number) {}

  proofOf(req: IncomingMessage): BoxProof {
    const proof = readBoxProof(req.headers.authorization);
    if (proof === null) throw notEnrolled();
    if (!withinSkew(proof.time, this.now())) throw new BoxAuthError('The clock of this box is more than five minutes off. Fix its time, then try again.', 401);
    return proof;
  }

  verify(request: BoxRequest, proof: BoxProof, signingKey: string): void {
    if (!boxSignatureValid(request, proof, signingKey)) throw notEnrolled();
  }

  remember(proof: BoxProof): void {
    this.prune();
    const nonce = `${proof.keyId}.${proof.nonce}`;
    if (this.nonces.has(nonce)) throw notEnrolled();
    const held = this.perKey.get(proof.keyId) ?? 0;
    if (held >= NONCES_PER_KEY) throw new BoxAuthError('This box sent too many requests. Wait a few minutes, then try again.', 429);
    if (this.nonces.size >= NONCES_MAX) throw new BoxAuthError('Metro is busy checking box requests. Try again in a few minutes.', 503);
    this.nonces.set(nonce, { keyId: proof.keyId, until: proof.time + BOX_CLOCK_SKEW_MS });
    this.perKey.set(proof.keyId, held + 1);
  }

  private prune(): void {
    const now = this.now();
    if (now - this.pruned < PRUNE_MS) return;
    this.pruned = now;
    for (const [nonce, seen] of this.nonces) {
      if (seen.until >= now) continue;
      this.nonces.delete(nonce);
      const left = (this.perKey.get(seen.keyId) ?? 1) - 1;
      if (left > 0) this.perKey.set(seen.keyId, left);
      else this.perKey.delete(seen.keyId);
    }
  }
}
