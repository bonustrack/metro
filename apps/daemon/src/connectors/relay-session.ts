import type { BlockedReason } from './relay-policy.js';
import type { RelayTarget } from './relay-target.js';

export interface RelaySession {
  target: (force: boolean) => Promise<RelayTarget>;
  current: () => RelayTarget;
  blocker: () => BlockedReason;
  signal: AbortSignal;
  close: () => void;
}
