import { activeAccount } from '../auth/account.js';
import { baseFromSegment, daemonBase } from '../auth/daemon.js';
import { accessToken, fetchOrganizations, organizationAccessToken } from './auth.js';
import { isRecord } from './read.js';

export interface CopyTarget {
  organization: string;
  organizationName: string;
  id: string;
  host: string;
  name: string;
}

export interface CopyResult {
  sourceId: string | null;
  id?: string;
  status: 'copied' | 'skipped' | 'invalid';
}

export async function connectorTransfer(base: string, path: 'prepare' | 'export' | 'receive', token: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/connectors/transfer/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error('Could not reach an agent. No existing connectors will be overwritten if you retry.');
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('Both agents need a Metro version that supports connector copy.');
    if (res.status === 401 || res.status === 403) throw new Error('You must be signed in as an admin of both organizations.');
    if (res.status === 409) throw new Error('A selected connector no longer exists. Refresh the list and choose again.');
    if (res.status === 410) throw new Error('The copy expired. Start again.');
    throw new Error(`Connector copy failed (${String(res.status)}). Retry safely; existing connectors are skipped.`);
  }
  return res.json() as Promise<unknown>;
}

function destinationBase(host: string): string {
  const base = baseFromSegment(host);
  const url = new URL(base);
  if (url.host !== host || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('Invalid destination agent address.');
  return url.origin;
}

function copyResults(body: unknown): CopyResult[] {
  if (!isRecord(body) || !Array.isArray(body.results)) throw new Error('The destination returned an unexpected response.');
  return body.results.map((row: unknown) => {
    if (!isRecord(row) || (row.sourceId !== null && typeof row.sourceId !== 'string') || !['copied', 'skipped', 'invalid'].includes(String(row.status)))
      throw new Error('The destination returned an unexpected response.');
    return { sourceId: row.sourceId, ...(typeof row.id === 'string' ? { id: row.id } : {}), status: row.status as CopyResult['status'] };
  });
}

async function authorizedDestination(target: CopyTarget, sourceBase: string): Promise<string> {
  const destination = destinationBase(target.host);
  if (new URL(sourceBase).origin === destination) throw new Error('Choose another agent.');
  const organizations = await fetchOrganizations();
  const organization = organizations.find((row) => row.id === target.organization && row.role === 'admin');
  if (!organization?.agents?.some((row) => row.id === target.id && row.host === target.host)) throw new Error('The destination is no longer an agent you administer.');
  return destination;
}

async function prepareCopy(base: string, token: string): Promise<{ ticket: string; publicKey: string }> {
  const prepared = await connectorTransfer(base, 'prepare', token, { confirmed: true });
  if (!isRecord(prepared) || typeof prepared.ticket !== 'string' || typeof prepared.publicKey !== 'string') throw new Error('The destination returned an unexpected response.');
  return { ticket: prepared.ticket, publicKey: prepared.publicKey };
}

export async function copyConnectors(target: CopyTarget, ids: string[] | null, confirmed: boolean): Promise<CopyResult[]> {
  if (!confirmed) throw new Error('Confirm copying saved logins and settings first.');
  const source = activeAccount();
  const sourceBase = daemonBase();
  if (source?.role !== 'admin' || source.organization === null) throw new Error('You must be an admin of the source organization.');
  const destination = await authorizedDestination(target, sourceBase);
  const destinationToken = await organizationAccessToken(target.organization);
  const sourceToken = await accessToken();
  if (sourceToken === null || activeAccount()?.organization !== source.organization || activeAccount()?.user.id !== source.user.id) throw new Error('Your account changed, start again.');
  const prepared = await prepareCopy(destination, destinationToken);
  const envelope = await connectorTransfer(sourceBase, 'export', sourceToken, { confirmed: true, ids, publicKey: prepared.publicKey });
  return copyResults(await connectorTransfer(destination, 'receive', destinationToken, { confirmed: true, ticket: prepared.ticket, envelope }));
}
