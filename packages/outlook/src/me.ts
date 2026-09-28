import { SignInError, type FetchLike } from '@metro-labs/core/stations/oauth';
import { graphBase } from './config.js';

export interface Mailbox {
  email: string;
  name: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const wrongMailbox = (actual: string, wanted: string): string =>
  `You signed in as ${actual}, not ${wanted}. Nothing was connected. Start again and pick ${wanted} on Microsoft's page, or use "Use another account".`;

export async function verifyMailbox(accessToken: string, fetchImpl: FetchLike, wanted: string | null = null): Promise<Mailbox> {
  let res: Response;
  try {
    res = await fetchImpl(`${graphBase()}/me?$select=mail,userPrincipalName,displayName`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
  } catch (err) {
    throw new SignInError(`Metro could not reach Microsoft Graph: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new SignInError(`Microsoft Graph refused the new sign-in (${String(res.status)}), so nothing was connected.`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const mail = text(body.mail).toLowerCase();
  const principal = text(body.userPrincipalName).toLowerCase();
  const email = mail || principal;
  if (email === '') throw new SignInError('Microsoft Graph did not say which mailbox this is, so nothing was connected.');
  if (wanted !== null && wanted !== mail && wanted !== principal) throw new SignInError(wrongMailbox(email, wanted));
  return { email, name: text(body.displayName) };
}
