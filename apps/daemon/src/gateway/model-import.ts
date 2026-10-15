import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import type { AgentKey } from '../connectors/agent-key.js';
import { agentCall, type MetroApi } from '../connectors/metro-api.js';
import { claudeLoginOf, claudeLoginsIn, isV2, modelPath, readModelFile, v3Text } from './claude-store.js';
import { isProvider, type Fallback } from './model-config.js';

const IMPORT_PATH = '/api/agents/models/import';
let lastRefusal = '';

const CODEX_FIELDS = ['clientId', 'subject', 'accountId', 'plan', 'email', 'accessToken', 'refreshToken', 'expiresAt', 'savedAt'] as const;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

type Row = Record<string, unknown>;

interface Plan {
  connections: Row[];
  sessionOnly: Set<string>;
  credentialed: number;
  gemini: number;
}

function codexOf(raw: unknown): Row | null {
  if (!isRecord(raw) || text(raw.accessToken) === '' || text(raw.refreshToken) === '') return null;
  const method = text(raw.accountId) !== '' ? 'code' : text(raw.clientId) !== '' ? 'chatgpt' : '';
  if (method === '') return null;
  return { method, ...Object.fromEntries(CODEX_FIELDS.flatMap((field) => (raw[field] === undefined ? [] : [[field, raw[field]]]))) };
}

function credentialOf(c: Row): Row | null {
  if (c.provider === 'codex') {
    const codex = codexOf(c.codex);
    return codex === null ? null : { codex };
  }
  return text(c.apiKey) === '' ? null : { apiKey: text(c.apiKey) };
}

function addRow(plan: Plan, c: Row): void {
  const base = { id: text(c.id), provider: c.provider, label: text(c.label), model: text(c.model), region: text(c.region), zdr: c.zdr === true };
  const login = c.provider === 'anthropic' ? claudeLoginOf(c.claude) : null;
  const credential = login === null ? credentialOf(c) : null;
  if (login !== null) plan.connections.push({ ...base, claude: { id: login.id } });
  else if (credential !== null) {
    plan.connections.push({ ...base, ...credential });
    plan.credentialed += 1;
  } else if (c.provider === 'anthropic') {
    plan.connections.push(base);
    plan.sessionOnly.add(base.id);
  }
}

function planOf(rows: Row[]): Plan {
  const plan: Plan = { connections: [], sessionOnly: new Set(), credentialed: 0, gemini: 0 };
  for (const c of rows) {
    if (c.provider === 'gemini') plan.gemini += 1;
    else if (text(c.id) !== '' && isProvider(c.provider)) addRow(plan, c);
  }
  return plan;
}

function fallbacksOf(raw: unknown, sent: Set<string>): Fallback[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f: unknown) => {
    const fallback = isRecord(f) ? { connection: text(f.connection), model: text(f.model) } : null;
    return fallback === null || !sent.has(fallback.connection) || fallback.model === '' ? [] : [fallback];
  });
}

function routeOf(raw: Row, rows: Row[], plan: Plan, fallbacks: Fallback[]): Fallback | '' {
  const id = text(raw.route);
  const routed = rows.find((c) => text(c.id) === id);
  if (routed === undefined || !plan.connections.some((c) => c.id === id)) return '';
  const route = { connection: id, model: text(routed.model) };
  return plan.sessionOnly.has(id) && route.model === '' && fallbacks.length === 0 ? '' : route;
}

function importBody(raw: Row & { connections: unknown[] }): { body: Row | null; sent: number; gemini: number } {
  const rows = raw.connections.filter(isRecord);
  const plan = planOf(rows);
  const fallbacks = fallbacksOf(raw.fallbacks, new Set(plan.connections.map((c) => text(c.id))));
  const route = routeOf(raw, rows, plan, fallbacks);
  const empty = plan.credentialed === 0 && route === '' && fallbacks.length === 0;
  return { body: empty ? null : { connections: plan.connections, route, fallbacks }, sent: plan.credentialed, gemini: plan.gemini };
}

export async function importModelFile(api: MetroApi, key: AgentKey, dir: string): Promise<void> {
  const raw = readModelFile(dir);
  if (!isV2(raw)) return;
  const { body, sent, gemini } = importBody(raw);
  try {
    if (body !== null) {
      const answer = await agentCall(api, key, IMPORT_PATH, body);
      if (!isRecord(answer.ids)) throw new Error('api.metro.box answered the import without ids');
    }
  } catch (err) {
    if (errMsg(err) !== lastRefusal) log.warn({ err: errMsg(err) }, 'org-models: the model setup of this box could not move to its organization yet; it is tried again');
    lastRefusal = errMsg(err);
    return;
  }
  lastRefusal = '';
  const logins = claudeLoginsIn(raw);
  writeSecure(modelPath(dir), v3Text(logins));
  if (gemini > 0) log.info({ dropped: gemini }, 'org-models: Gemini connections are no longer supported, so they were dropped');
  log.info({ moved: sent, claudeLogins: logins.length }, 'org-models: the model setup of this box moved to its organization; model.json keeps only its Claude logins');
}
