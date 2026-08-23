import { makeCodeStore } from './pair-codes.js';

export interface CliCode {
  email: string;
  collectionId: string;
}

const store = makeCodeStore<CliCode>('mc');

export const CLI_CODE_RE = store.pattern;

export const mintCliCode = (
  entry: CliCode,
  now?: number,
): { code: string; expiresAt: number } => store.mint(entry, now);

export const takeCliCode = (code: string, now?: number): CliCode | undefined =>
  store.take(code, now);

export const cliCodeCount = (): number => store.count();
