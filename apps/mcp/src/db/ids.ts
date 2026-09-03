import { randomBytes } from 'node:crypto';

const ID_BYTES = 8;
const REROLLS = 16;

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{10}$/;

export function newId(): string {
  for (let attempt = 0; attempt < REROLLS; attempt += 1) {
    const id = randomBytes(ID_BYTES).toString('base64url');
    if (ID_RE.test(id)) return id;
  }
  throw new Error('could not generate an id');
}

export function parseId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return ID_RE.test(raw) ? raw : null;
}

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
