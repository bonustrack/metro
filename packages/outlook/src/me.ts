import { OutlookAuthError, type FetchLike } from './auth.js';
import { graphBase } from './config.js';

export interface Mailbox {
  email: string;
  name: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function verifyMailbox(accessToken: string, fetchImpl: FetchLike): Promise<Mailbox> {
  let res: Response;
  try {
    res = await fetchImpl(`${graphBase()}/me?$select=mail,userPrincipalName,displayName`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
  } catch (err) {
    throw new OutlookAuthError(`Metro could not reach Microsoft Graph: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new OutlookAuthError(`Microsoft Graph refused the new sign-in (${String(res.status)}), so nothing was connected.`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const email = text(body.mail) || text(body.userPrincipalName);
  if (email === '') throw new OutlookAuthError('Microsoft Graph did not say which mailbox this is, so nothing was connected.');
  return { email: email.toLowerCase(), name: text(body.displayName) };
}
