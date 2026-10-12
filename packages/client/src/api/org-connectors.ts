import { filled, isRecord, recordOf, str } from '../read.js';
import { builtInDaemon } from '../auth/daemon.js';
import { location, signInReturnUrl } from '../platform.js';
import { call, type CallInit } from './client.js';
import { accountIdentity, accountScopeIdentity, checkAccountIdentity } from '../auth/account.js';

export type OrgConnectorAuth = 'none' | 'header' | 'oauth';

export interface OrgConnectorAgent {
  id: string;
  readOnly: boolean;
  assignedAt: string;
}

export interface OrgConnector {
  id: string;
  name: string;
  url: string;
  auth: OrgConnectorAuth;
  header: string | null;
  signIn: 'connected' | 'disconnected' | null;
  server: string | null;
  verifiedAt: string | null;
  clientId: string | null;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
  agents: OrgConnectorAgent[];
}

export interface OrgConnectors {
  connectors: OrgConnector[];
  admin: boolean;
}

export interface NewOrgConnector {
  name: string;
  url: string;
  header: string;
  value: string;
  clientId: string;
  clientSecret: string;
  oauthResource?: string;
}

export type OrgAddResult = { kind: 'added'; connector: OrgConnector } | { kind: 'oauth'; connector: OrgConnector; authorizeUrl: string };

export interface OrgConnectorEvent {
  id: string;
  at: string;
  action: string;
  actor: string;
  connector: { id: string; name: string | null } | null;
  agent: { id: string; name: string | null } | null;
  detail: Record<string, string>;
}

export interface OrgEventPage {
  before: string;
  beforeId: string;
}

export interface OrgConnectorEvents {
  events: OrgConnectorEvent[];
  next: OrgEventPage | null;
}

export type OrgConnectorReturn = { kind: 'handoff'; handoff: string } | { kind: 'error'; error: string };

const JSON_HEADERS = { 'content-type': 'application/json' };
const RETURN_PARAM = 'org_connector';
const ERROR_PARAM = 'org_connector_error';
const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const base = (): string => `${builtInDaemon()}/api/connectors`;

function orgCall(init: CallInit): Promise<unknown> {
  const identity = accountIdentity();
  const scope = accountScopeIdentity();
  return call({ ...init, checkAccount: () => {
    checkAccountIdentity(identity);
    if (scope !== accountScopeIdentity()) throw new Error('The Metro account changed. Start again.');
    init.checkAccount?.();
  } });
}


export const orgConnectorCallbackUrl = (): string => `${base()}/callback`;
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const authOf = (value: unknown): OrgConnectorAuth => (value === 'header' || value === 'oauth' ? value : 'none');
const signInOf = (value: unknown): OrgConnector['signIn'] => (value === 'connected' || value === 'disconnected' ? value : null);

export function toOrgConnector(value: unknown): OrgConnector {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') throw unexpected();
  return {
    id: value.id,
    name: value.name,
    url: str(value.url),
    auth: authOf(value.auth),
    header: filled(value.header),
    signIn: signInOf(value.signIn),
    server: filled(value.server),
    verifiedAt: filled(value.verifiedAt),
    clientId: filled(value.clientId),
    readOnly: value.readOnly === true,
    createdAt: str(value.createdAt),
    updatedAt: str(value.updatedAt),
    agents: records(value.agents).map((a) => ({ id: str(a.id), readOnly: a.readOnly === true, assignedAt: str(a.assignedAt) })),
  };
}

function actorOf(value: unknown): string {
  const actor = recordOf(value);
  if (actor.kind === 'user') return filled(actor.name) ?? filled(actor.email) ?? 'Someone';
  return actor.kind === 'metro' ? 'Metro' : 'A box';
}

const named = (value: unknown): { id: string; name: string | null } | null => (isRecord(value) && typeof value.id === 'string' ? { id: value.id, name: filled(value.name) } : null);

export function toOrgEvents(value: unknown): OrgConnectorEvents {
  if (!isRecord(value)) throw unexpected();
  const next = recordOf(value.next);
  return {
    events: records(value.events).map((e) => ({
      id: str(e.id),
      at: str(e.at),
      action: str(e.action),
      actor: actorOf(e.actor),
      connector: named(e.connector),
      agent: named(e.agent),
      detail: Object.fromEntries(Object.entries(recordOf(e.detail)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    })),
    next: typeof next.before === 'string' && typeof next.beforeId === 'string' ? { before: next.before, beforeId: next.beforeId } : null,
  };
}

export const isWebAddress = (url: string): boolean => {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

function authorizeOf(body: Record<string, unknown>): string {
  const url = str(body.authorizeUrl);
  if (!isWebAddress(url)) throw new Error('That server sent a sign-in address Metro will not open.');
  return url;
}

export async function readOrgConnectors(checkAccount?: () => void, signal?: AbortSignal): Promise<OrgConnectors> {
  const body = await orgCall({ method: 'GET', base: base(), checkAccount, signal });
  if (!isRecord(body) || !Array.isArray(body.connectors)) throw unexpected();
  return { connectors: body.connectors.map(toOrgConnector), admin: body.admin === true };
}

export const fetchOrgConnectors = (): Promise<OrgConnectors> => readOrgConnectors();

function addPayload(input: NewOrgConnector): Record<string, string> {
  const out: Record<string, string> = { name: input.name.trim(), url: input.url.trim(), returnTo: signInReturnUrl() };
  for (const key of ['header', 'value', 'clientId', 'clientSecret'] as const) if (input[key].trim() !== '') out[key] = input[key].trim();
  if (input.oauthResource?.trim()) out.oauthResource = input.oauthResource.trim();
  return out;
}

export async function addOrgConnector(input: NewOrgConnector): Promise<OrgAddResult> {
  const body = recordOf(await orgCall({ method: 'POST', base: base(), headers: JSON_HEADERS, body: JSON.stringify(addPayload(input)) }));
  const connector = toOrgConnector(body.connector);
  return body.authorizeUrl === undefined ? { kind: 'added', connector } : { kind: 'oauth', connector, authorizeUrl: authorizeOf(body) };
}

const change = async (id: string, body: Record<string, unknown>): Promise<OrgConnector> =>
  toOrgConnector(await orgCall({ method: 'PUT', base: base(), path: `/${id}`, headers: JSON_HEADERS, body: JSON.stringify(body) }));

export const renameOrgConnector = (id: string, name: string): Promise<OrgConnector> => change(id, { name });

export const setOrgConnectorReadOnly = (id: string, readOnly: boolean): Promise<OrgConnector> => change(id, { readOnly });

export const replaceOrgConnectorKey = (id: string, header: string, value: string): Promise<OrgConnector> => change(id, { header: header.trim(), value: value.trim() });

export async function deleteOrgConnector(id: string): Promise<void> {
  await orgCall({ method: 'DELETE', base: base(), path: `/${id}` });
}

export const signInOrgConnector = async (id: string, checkAccount?: () => void, signal?: AbortSignal, oauthResource?: string): Promise<string> =>
  authorizeOf(recordOf(await orgCall({ method: 'POST', base: base(), path: `/${id}/sign-in`, headers: JSON_HEADERS, body: JSON.stringify({ returnTo: signInReturnUrl(), ...(oauthResource?.trim() ? { oauthResource: oauthResource.trim() } : {}) }), checkAccount, signal })));

export const completeOrgConnectorSignIn = async (handoff: string): Promise<OrgConnector> =>
  toOrgConnector(await orgCall({ method: 'POST', base: base(), path: '/complete', headers: JSON_HEADERS, body: JSON.stringify({ handoff }) }));

export const assignOrgConnector = async (id: string, agent: string, readOnly: boolean): Promise<OrgConnector> =>
  toOrgConnector(await orgCall({ method: 'PUT', base: base(), path: `/${id}/agents/${agent}`, headers: JSON_HEADERS, body: JSON.stringify({ readOnly }) }));

export const unassignOrgConnector = async (id: string, agent: string): Promise<OrgConnector> =>
  toOrgConnector(await orgCall({ method: 'DELETE', base: base(), path: `/${id}/agents/${agent}` }));

export async function fetchOrgConnectorEvents(connector: string | null, page: OrgEventPage | null): Promise<OrgConnectorEvents> {
  const query = new URLSearchParams();
  if (connector !== null) query.set('connector', connector);
  if (page !== null) {
    query.set('before', page.before);
    query.set('beforeId', page.beforeId);
  }
  const text = query.toString();
  return toOrgEvents(await orgCall({ method: 'GET', base: base(), path: `/events${text === '' ? '' : `?${text}`}` }));
}

export function readOrgConnectorReturn(search: string, hash = ''): { result: OrgConnectorReturn | null; search: string; hash: string } {
  const cut = hash.indexOf('?');
  const fromHash = cut !== -1 && /^#\/.*organization\/connectors\/[A-Za-z0-9_-]{11}\?/.test(hash);
  const params = new URLSearchParams(fromHash ? hash.slice(cut + 1) : search);
  const handoff = params.get(RETURN_PARAM);
  const error = params.get(ERROR_PARAM);
  if (handoff === null && error === null) return { result: null, search, hash };
  params.delete(RETURN_PARAM);
  params.delete(ERROR_PARAM);
  const result: OrgConnectorReturn = error === null ? { kind: 'handoff', handoff: handoff ?? '' } : { kind: 'error', error };
  const rest = params.toString();
  const query = rest === '' ? '' : `?${rest}`;
  return fromHash ? { result, search, hash: `${hash.slice(0, cut)}${query}` } : { result, search: query, hash };
}

export function takeOrgConnectorReturn(): OrgConnectorReturn | null {
  const back = readOrgConnectorReturn(location().search(), location().hash());
  if (back.result !== null) {
    location().clearSearch(back.search.replace(/^\?/, ''));
    location().replace(back.hash);
  }
  return back.result;
}

interface Said {
  who: string;
  name: string;
  agent: string;
  detail: Record<string, string>;
}

const ACTIONS: Record<string, (s: Said) => string> = {
  'connector.created': (s) => `${s.who} added ${s.name}`,
  'connector.renamed': (s) => `${s.who} renamed ${s.name} to ${s.detail.to ?? 'a new name'}`,
  'connector.read_only_changed': (s) => (s.detail.readOnly === 'yes' ? `${s.who} made ${s.name} read-only for every agent` : `${s.who} let agents write with ${s.name} again`),
  'connector.key_changed': (s) => `${s.who} replaced the key of ${s.name}`,
  'connector.signed_in': (s) => `${s.who} signed ${s.name} in`,
  'connector.refreshed': (s) => `Metro refreshed ${s.name} for ${s.agent}`,
  'connector.refresh_failed': (s) => `Metro could not refresh ${s.name} for ${s.agent}`,
  'connector.signed_out': (s) => `${s.name} needs signing in again`,
  'connector.delivered': (s) => `Metro prepared ${s.name} for ${s.agent}`,
  'connector.deleted': (s) => `${s.who} removed ${s.name}`,
  'connector.assigned': (s) => `${s.who} gave ${s.name} to ${s.agent}${s.detail.readOnly === 'yes' ? ', read-only' : ''}`,
  'connector.assignment_changed': (s) => `${s.who} made ${s.name} ${s.detail.readOnly === 'yes' ? 'read-only' : 'writable'} for ${s.agent}`,
  'connector.unassigned': (s) => `${s.who} took ${s.name} from ${s.agent}`,
  'agent.enrolled': (s) => `${s.who} enrolled ${s.agent}`,
  'agent.unenrolled': (s) => `${s.agent} moved to another organization, so its agent key and connectors were removed`,
};

export function orgEventText(event: OrgConnectorEvent, agentName: (id: string) => string | null): string {
  const said: Said = {
    who: event.actor,
    name: event.connector?.name ?? event.detail.name ?? 'a connector',
    agent: event.agent === null ? 'an agent' : (agentName(event.agent.id) ?? event.agent.name ?? event.agent.id),
    detail: event.detail,
  };
  const action = event.action === 'box.enrolled' ? 'agent.enrolled' : event.action === 'box.unenrolled' ? 'agent.unenrolled' : event.action;
  const say = ACTIONS[action];
  return say === undefined ? `${said.who}: ${event.action}` : say(said);
}
