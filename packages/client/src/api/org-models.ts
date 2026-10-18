import { isRecord, recordOf, str } from '../read.js';
import { activeAccount } from '../auth/account.js';
import { builtInDaemon } from '../auth/daemon.js';
import { signInReturnUrl } from '../platform.js';
import { orgCall } from './org-connectors.js';
import { toConnection, type ConnectionRow, type Provider } from './model.js';
import { toModelOptions, type ModelOption } from './model-options.js';
import { toRoute, type ModelRoute } from './model-route.js';

export interface OrgModelConnection extends ConnectionRow {
  createdAt: string;
}

export interface OrgModels {
  connections: OrgModelConnection[];
  default: ModelRoute | null;
  agents: Record<string, ModelRoute>;
  admin: boolean;
}

export interface NewOrgModel {
  provider: Provider;
  label: string;
  apiKey?: string;
  claudeToken?: string;
  model?: string;
  region?: string;
  zdr?: boolean;
}

export interface OrgModelPatch {
  label?: string;
  model?: string;
  region?: string;
  zdr?: boolean;
  apiKey?: string;
  claudeToken?: string;
}

export interface DeviceLogin {
  id: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
}

export type DevicePoll = { status: 'pending' } | { status: 'done' } | { status: 'failed'; error: string };

const JSON_HEADERS = { 'content-type': 'application/json' };
const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const base = (): string => `${builtInDaemon()}/api/models`;
const send = (method: 'POST' | 'PUT' | 'PATCH', path: string, body: Record<string, unknown>): Promise<unknown> =>
  orgCall({ method, base: base(), path, headers: JSON_HEADERS, body: JSON.stringify(body) });

function toOrgConnection(raw: unknown): OrgModelConnection | null {
  const row = toConnection(raw);
  return row === null ? null : { ...row, createdAt: str(recordOf(raw).createdAt) };
}

function routesOf(raw: unknown): Record<string, ModelRoute> {
  const out: Record<string, ModelRoute> = {};
  for (const [agent, value] of Object.entries(recordOf(raw))) {
    const route = toRoute(value);
    if (route !== null) out[agent] = route;
  }
  return out;
}

export function toOrgModels(body: unknown): OrgModels {
  if (!isRecord(body) || !Array.isArray(body.connections)) throw unexpected();
  return {
    connections: body.connections.flatMap((raw: unknown) => toOrgConnection(raw) ?? []),
    default: toRoute(body.default),
    agents: routesOf(body.agents),
    admin: typeof body.admin === 'boolean' ? body.admin : activeAccount()?.role === 'admin',
  };
}

export const fetchOrgModels = async (): Promise<OrgModels> => toOrgModels(await orgCall({ method: 'GET', base: base() }));

function idOf(body: unknown): string | null {
  const record = recordOf(body);
  const id = typeof record.id === 'string' ? record.id : recordOf(record.connection).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

export async function addOrgModel(input: NewOrgModel): Promise<string | null> {
  const credential = input.claudeToken === undefined ? { apiKey: (input.apiKey ?? '').trim() } : { claudeToken: input.claudeToken.trim() };
  return idOf(await send('POST', '', { ...input, label: input.label.trim(), ...credential }));
}

export async function updateOrgModel(id: string, patch: OrgModelPatch): Promise<void> {
  await send('PATCH', `/${encodeURIComponent(id)}`, { ...patch });
}

export async function deleteOrgModel(id: string): Promise<void> {
  await orgCall({ method: 'DELETE', base: base(), path: `/${encodeURIComponent(id)}` });
}

export async function setModelRoute(agent: string | null, route: ModelRoute): Promise<void> {
  await send('PUT', '/route', { agent, primary: route.primary, fallbacks: route.fallbacks, helpers: route.helpers ?? null, effort: route.effort ?? null });
}

export async function clearModelRoute(agent: string | null): Promise<void> {
  await orgCall({ method: 'DELETE', base: base(), path: agent === null ? '/route' : `/route?agent=${encodeURIComponent(agent)}` });
}

export async function fetchOrgModelList(id: string, signal?: AbortSignal): Promise<ModelOption[]> {
  return toModelOptions(await orgCall({ method: 'GET', base: base(), path: `/${encodeURIComponent(id)}/models`, signal }));
}

function httpsAddress(value: unknown, origin?: string): string {
  if (typeof value !== 'string') throw unexpected();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (origin !== undefined && url.origin !== origin)) throw unexpected();
    return value;
  } catch {
    throw new Error('Metro sent a sign-in address it will not open.');
  }
}

const authorizeOf = (body: unknown, origin?: string): string => {
  const record = recordOf(body);
  return httpsAddress(record.authorizeUrl ?? record.url, origin);
};

const withConnection = (connection: string): Record<string, string> => (connection === '' ? {} : { connection });

export const beginOrgCodexLogin = async (connection = ''): Promise<string> => authorizeOf(await send('POST', '/codex/login', withConnection(connection)));

export async function finishOrgCodexLogin(url: string): Promise<void> {
  await send('POST', '/codex/callback', { url: url.trim() });
}

export async function beginOrgCodexDevice(connection = ''): Promise<DeviceLogin> {
  const body = recordOf(await send('POST', '/codex/device', withConnection(connection)));
  const userCode = body.userCode ?? body.user_code;
  if (typeof body.id !== 'string' || typeof userCode !== 'string') throw unexpected();
  const interval = typeof body.interval === 'number' && body.interval >= 1 ? body.interval : 5;
  return { id: body.id, userCode, verifyUrl: httpsAddress(body.verifyUrl ?? body.verify_url), interval };
}

export async function pollOrgCodexDevice(id: string): Promise<DevicePoll> {
  const body = recordOf(await orgCall({ method: 'GET', base: base(), path: `/codex/device/${encodeURIComponent(id)}` }));
  if (body.status === 'done') return { status: 'done' };
  if (body.status === 'failed') return { status: 'failed', error: typeof body.error === 'string' ? body.error : 'The sign-in did not finish.' };
  return { status: 'pending' };
}

export function beginOrgOpenRouterLogin(connection = ''): Promise<string> {
  const back = signInReturnUrl();
  return send('POST', '/openrouter/login', { ...withConnection(connection), ...(back === '' ? {} : { returnTo: back }) }).then((body) => authorizeOf(body, 'https://openrouter.ai'));
}

export type OpenRouterReturn = { kind: 'done'; connection: string } | { kind: 'error'; error: string };

const DONE_PARAM = 'openrouter';
const ERROR_PARAM = 'openrouter_error';

export function readOpenRouterReturn(hash: string): { result: OpenRouterReturn | null; hash: string } {
  const cut = hash.indexOf('?');
  if (cut === -1 || !hash.slice(0, cut).endsWith('organization/models')) return { result: null, hash };
  const params = new URLSearchParams(hash.slice(cut + 1));
  const done = params.get(DONE_PARAM);
  const error = params.get(ERROR_PARAM);
  if (done === null && error === null) return { result: null, hash };
  params.delete(DONE_PARAM);
  params.delete(ERROR_PARAM);
  const rest = params.toString();
  const result: OpenRouterReturn = error === null ? { kind: 'done', connection: done ?? '' } : { kind: 'error', error };
  return { result, hash: `${hash.slice(0, cut)}${rest === '' ? '' : `?${rest}`}` };
}
