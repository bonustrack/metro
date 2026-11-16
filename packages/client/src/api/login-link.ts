import { builtInDaemon } from '../auth/daemon.js';
import { fetchNoRedirect } from '../platform.js';
import { isRecord } from '../read.js';

const LINK_RE = /^#\/auth\/link\/([A-Za-z0-9_-]{43})$/;
const LINK_REFUSED = '#/login?refused=link';
const TOO_MANY = '#/login?refused=too-many';

export const loginLinkCode = (hash: string): string | null => LINK_RE.exec(hash)?.[1] ?? null;

export async function redeemLoginLink(code: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchNoRedirect(`${builtInDaemon()}/api/auth/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  if (res.status === 400 || res.status === 404) return LINK_REFUSED;
  if (res.status === 429) return TOO_MANY;
  if (!res.ok) throw new Error(`Metro returned ${String(res.status)}.`);
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || typeof body.hash !== 'string' || !body.hash.startsWith('#/')) throw new Error('Metro returned an unexpected response.');
  return body.hash;
}
