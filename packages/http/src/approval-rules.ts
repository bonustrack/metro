import { AGENT_PAGES, isSlugSegment } from '@metro-labs/core/route-segments';

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

export const APP_ORIGIN = 'https://metro.box';

export function appOriginOf(text: string | undefined): string | null {
  const value = (text ?? '').trim().replace(/\/+$/, '');
  if (value === '') return APP_ORIGIN;
  return /^https?:\/\/[^/?#\s]+$/.test(value) ? value : null;
}

export interface ApprovalAgent {
  owner: string | null;
  agent: string | null;
  ownerSlug?: string | null;
  agentSlug?: string | null;
}

const usable = (slug: string | null | undefined): slug is string => typeof slug === 'string' && isSlugSegment(slug);

const agentSegment = (agent: string, slug: string | null | undefined): string => (usable(slug) && !AGENT_PAGES.has(slug) ? slug : agent);

export function approvalLink(origin: string, where: ApprovalAgent, id: string): string {
  if (where.owner === null) return origin;
  const organization = `${origin}/#/${encodeURIComponent(usable(where.ownerSlug) ? where.ownerSlug : where.owner)}`;
  return where.agent === null ? `${organization}/agents` : `${organization}/${encodeURIComponent(agentSegment(where.agent, where.agentSlug))}/approvals/${encodeURIComponent(id)}`;
}
