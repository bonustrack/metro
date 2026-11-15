import { NotFoundError } from '@metro-labs/client/api/client';
import type { Decision } from '@metro-labs/client/api/approvals';
import type { Selection } from '@metro-labs/client/selection';

export type Outcome = Decision | 'gone' | null;

export type ApprovalPageState<T> =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'waiting'; item: T }
  | { kind: 'answered'; item: T; decision: Decision }
  | { kind: 'gone' };

export interface ApprovalRead<T> {
  data?: T[] | undefined;
  error: unknown;
}

export interface Answering<T> {
  held: T | null;
  outcome: Outcome;
}

export interface AnswerState<T> extends Answering<T> {
  busy: Decision | null;
  error: string | null;
}

interface AnswerSteps<T> {
  send: (decision: Decision) => Promise<void>;
  refresh: () => Promise<void>;
  update: (patch: Partial<AnswerState<T>>) => void;
  errorText: (err: unknown) => string;
}

interface Words {
  title: string;
  text: string;
}

export const DECIDE_FAILED = 'Could not send your answer.';

export function approvalPageState<T>(read: ApprovalRead<T>, pick: (items: T[]) => T | undefined, answering: Answering<T>): ApprovalPageState<T> {
  const { held, outcome } = answering;
  if (outcome === 'gone') return { kind: 'gone' };
  if (held !== null) return outcome === null ? { kind: 'waiting', item: held } : { kind: 'answered', item: held, decision: outcome };
  if (read.data === undefined) return read.error === null || read.error === undefined ? { kind: 'loading' } : { kind: 'failed' };
  const item = pick(read.data);
  return item === undefined ? { kind: 'gone' } : { kind: 'waiting', item };
}

export const ANSWER_IDLE = { held: null, outcome: null, busy: null, error: null } as const;

export async function runAnswer<T>(item: T, decision: Decision, steps: AnswerSteps<T>): Promise<void> {
  steps.update({ held: item, busy: decision, error: null });
  try {
    await steps.send(decision);
    steps.update({ outcome: decision, busy: null });
  } catch (err) {
    steps.update(err instanceof NotFoundError ? { outcome: 'gone', busy: null } : { held: null, busy: null, error: steps.errorText(err) });
  }
  await steps.refresh();
}

export const resultWords = (decision: Decision, name: string): Words =>
  decision === 'allow' ? { title: 'Approved', text: `${name} can run it now.` } : { title: 'Denied', text: `${name} cannot run it.` };

export const GONE_WORDS: Words = {
  title: 'This request is no longer waiting',
  text: 'It was already answered, it expired, or the link is not right.',
};

interface GateFailure {
  segment: string;
  text: string;
  refused: boolean;
}

export function gateFailureText(kind: Selection['kind'], failure: GateFailure): string {
  if (kind !== 'approval' || !failure.refused) return `${failure.segment}: ${failure.text}`;
  return `You cannot answer this request with this account: ${failure.text.replace(/\.$/, '')}.`;
}
