import type { IncomingMessage } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { AGENT_CLOCK_SKEW_MS, agentSignatureValid, readAgentProof, withinSkew, type AgentProof } from '@metro-labs/http/agent-signature';

const PRUNE_MS = 60_000;
const BROWSER_HEADERS = ['origin', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user'];

export class AgentAuthError extends ApiError {}

export const notEnrolled = (): AgentAuthError => new AgentAuthError('This agent is not enrolled with Metro, or its request signature is not valid.', 401);

export function refuseBrowser(req: IncomingMessage): void {
  if (BROWSER_HEADERS.some((name) => req.headers[name] !== undefined)) throw new AgentAuthError('Only a Metro agent may call this, not a browser.', 403);
}

export interface NonceLimits {
  total: number;
  perOwner: number;
  perKey: number;
}

const LIMITS: NonceLimits = { total: 200_000, perOwner: 20_000, perKey: 600 };

interface Seen {
  keyId: string;
  owner: string;
  until: number;
}

export class AgentAuth {
  private readonly nonces = new Map<string, Seen>();
  private readonly held = new Map<string, number>();
  private pruned = 0;

  constructor(
    private readonly host: string,
    private readonly now: () => number,
    private readonly limits: NonceLimits = LIMITS,
  ) {}

  proofOf(req: IncomingMessage): AgentProof {
    const proof = readAgentProof(req.headers.authorization);
    if (proof === null) throw notEnrolled();
    if (!withinSkew(proof.time, this.now())) throw new AgentAuthError('The clock of this agent is more than five minutes off. Fix its time, then try again.', 401);
    return proof;
  }

  accept(req: IncomingMessage, body: Buffer, proof: AgentProof, signingKey: string, owner: string): void {
    const request = { method: req.method ?? '', host: this.host, path: req.url ?? '', body };
    if (!agentSignatureValid(request, proof, signingKey)) throw notEnrolled();
    this.remember(proof, owner);
  }

  private remember(proof: AgentProof, owner: string): void {
    this.prune();
    const nonce = `${proof.keyId}.${proof.nonce}`;
    if (this.nonces.has(nonce)) throw notEnrolled();
    if (this.count(`key ${proof.keyId}`) >= this.limits.perKey) throw new AgentAuthError('This agent sent too many requests. Wait a few minutes, then try again.', 429);
    if (this.count(`owner ${owner}`) >= this.limits.perOwner) throw new AgentAuthError('The agents of this organization sent too many requests. Wait a few minutes, then try again.', 429);
    if (this.nonces.size >= this.limits.total) throw new AgentAuthError('Metro is busy checking agent requests. Try again in a few minutes.', 503);
    this.nonces.set(nonce, { keyId: proof.keyId, owner, until: proof.time + AGENT_CLOCK_SKEW_MS });
    this.bump(`key ${proof.keyId}`, 1);
    this.bump(`owner ${owner}`, 1);
  }

  private count(name: string): number {
    return this.held.get(name) ?? 0;
  }

  private bump(name: string, by: number): void {
    const next = this.count(name) + by;
    if (next > 0) this.held.set(name, next);
    else this.held.delete(name);
  }

  private prune(): void {
    const now = this.now();
    if (now - this.pruned < PRUNE_MS) return;
    this.pruned = now;
    for (const [nonce, seen] of this.nonces) {
      if (seen.until >= now) continue;
      this.nonces.delete(nonce);
      this.bump(`key ${seen.keyId}`, -1);
      this.bump(`owner ${seen.owner}`, -1);
    }
  }
}
