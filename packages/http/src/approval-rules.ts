const APPROVAL_ID_PATTERN = '^[a-km-z]{5}$';
export const APPROVAL_ID_RE = new RegExp(APPROVAL_ID_PATTERN);
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
export const APPROVAL_USE_MS = 10 * 60_000;
export const APPROVAL_PENDING_MAX = 50;

export const APPROVAL_PROPERTY = {
  type: 'string',
  pattern: APPROVAL_ID_PATTERN,
  description: 'The 5-letter approval id, only when repeating a call the owner approved.',
} as const;

export const TOO_MANY_PENDING = `${String(APPROVAL_PENDING_MAX)} approval requests are already waiting for the owner. Wait for answers before asking again.`;
