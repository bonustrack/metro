import { makeCodeStore } from './pair-codes.js';

export interface RunCode {
  email: string;
  agentId: string;
}

const store = makeCodeStore<RunCode>('mr');

export const RUN_CODE_RE = store.pattern;

export const mintRunCode = (
  entry: RunCode,
  now?: number,
): { code: string; expiresAt: number } => store.mint(entry, now);

export const takeRunCode = (code: string, now?: number): RunCode | undefined =>
  store.take(code, now);
