const NAME_CACHE_MAX = 5000;
const convNameCache = new Map<string, string>();

function remember(convId: string, name: string): void {
  convNameCache.delete(convId);
  convNameCache.set(convId, name);
  if (convNameCache.size > NAME_CACHE_MAX) {
    const oldest = convNameCache.keys().next().value;
    if (oldest !== undefined) convNameCache.delete(oldest);
  }
}

async function readName(conv: unknown): Promise<string> {
  try {
    if (typeof (conv as { peerInboxId?: unknown }).peerInboxId === 'function')
      return '';
    const n = (conv as { name?: string | (() => Promise<string>) }).name;
    const resolved = typeof n === 'function' ? await n() : n;
    return typeof resolved === 'string' ? resolved : '';
  } catch {
    return '';
  }
}

export async function groupNameFor(
  convId: string,
  conv: unknown,
): Promise<string> {
  const cached = convNameCache.get(convId);
  if (cached !== undefined) return cached;
  const name = await readName(conv);
  remember(convId, name);
  return name;
}

export function warmGroupName(convId: string, name: string | undefined): void {
  if (typeof name === 'string' && name) remember(convId, name);
}
