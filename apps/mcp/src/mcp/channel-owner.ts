import { eventInScope } from '../db/agent-scope.js';
import { allowedAgents, type RequestIdentity } from './request-identity.js';

const sameScope = (a: Set<number>, b: Set<number>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id));

export class ChannelOwner {
  private stream: RequestIdentity | undefined;

  bindStream(identity: RequestIdentity): void {
    this.stream = identity;
  }

  releaseStream(): void {
    this.stream = undefined;
  }

  scope(): Set<number> {
    return allowedAgents(this.stream);
  }

  streamBelongsTo(identity: RequestIdentity): boolean {
    if (this.stream === undefined) return false;
    return sameScope(allowedAgents(this.stream), allowedAgents(identity));
  }

  inScope(line: string): boolean {
    if (this.stream === undefined) return false;
    return eventInScope(this.scope(), line);
  }
}
