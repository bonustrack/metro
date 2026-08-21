import { eventInScope } from '../db/agent-scope.js';
import { allowedAgents, type RequestIdentity } from './request-identity.js';
import { sessionScopeKey } from './session-route.js';

export class ChannelOwner {
  private stream: RequestIdentity | undefined;

  bindStream(identity: RequestIdentity): void {
    this.stream = identity;
  }

  releaseStream(): void {
    this.stream = undefined;
  }

  scope(): Set<string> {
    return allowedAgents(this.stream);
  }

  streamBelongsTo(identity: RequestIdentity): boolean {
    if (this.stream === undefined) return false;
    return sessionScopeKey(this.stream) === sessionScopeKey(identity);
  }

  inScope(line: string): boolean {
    if (this.stream === undefined) return false;
    return eventInScope(this.scope(), line);
  }
}
