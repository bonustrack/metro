const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 6)}…` : id);

export function reactionEmoji(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const obj = raw as { name?: string; reaction?: string } | undefined;
  return obj?.name ?? obj?.reaction ?? '';
}

export function reactContent(emoji: string, target: string, removed: boolean): string {
  const verb = removed ? 'removed from' : 'reacted to';
  const label = removed ? emoji || 'reaction' : emoji || 'reacted';
  return `${label} ${verb} message ${shortId(target)}`.trim();
}
