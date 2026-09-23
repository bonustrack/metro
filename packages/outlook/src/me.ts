import { OutlookAuthError, type FetchLike } from './auth.js';
import { graphBase } from './config.js';

export interface Mailbox {
  email: string;
  name: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const MAILBOX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseMailbox(value: unknown): string | null {
  const mailbox = text(value).toLowerCase();
  if (mailbox === '') return null;
  if (!MAILBOX_RE.test(mailbox))
    throw new OutlookAuthError('Type the whole address of the mailbox, like andy@company.com, or leave it blank.');
  return mailbox;
}

const wrongMailbox = (actual: string, wanted: string): string =>
  `You signed in as ${actual}, not ${wanted}. Nothing was connected. Start again and pick ${wanted} on Microsoft's page, or use "Use another account".`;

export async function verifyMailbox(accessToken: string, fetchImpl: FetchLike, wanted: string | null = null): Promise<Mailbox> {
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
  const mail = text(body.mail).toLowerCase();
  const principal = text(body.userPrincipalName).toLowerCase();
  const email = mail || principal;
  if (email === '') throw new OutlookAuthError('Microsoft Graph did not say which mailbox this is, so nothing was connected.');
  if (wanted !== null && wanted !== mail && wanted !== principal) throw new OutlookAuthError(wrongMailbox(email, wanted));
  return { email, name: text(body.displayName) };
}
