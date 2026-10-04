import { namedSegment } from './org-segment.js';

const slugs = new Map<string, string>();

export function rememberAgents(servers: { id: string; slug: string | null }[]): void {
  for (const s of servers) {
    if (s.slug === null) slugs.delete(s.id);
    else slugs.set(s.id, s.slug);
  }
}

export const agentSegment = (idOrSlug: string): string => namedSegment(idOrSlug, slugs.get(idOrSlug) ?? null);

export const forgetAgents = (): void => {
  slugs.clear();
};
