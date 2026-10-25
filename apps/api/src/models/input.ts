import { isClaudeToken } from '@metro-labs/core/claude-token';
import { EFFORT_LEVELS, isEffortLevel, type RouteEffort } from '@metro-labs/core/effort';
import { ID_RE, newId, parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { distinctFallbacks, FALLBACKS_MAX, MODEL_ID_MAX, type RouteChain, type RouteTarget } from '@metro-labs/connectors/model-route';
import { modelDetailOf, type ModelProvider } from '@metro-labs/connectors/model-secret';
import type { Caller } from './deps.js';

export const LABEL_MAX = 60;
export const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const API_KEY_RE = /^[\x21-\x7e]{1,4096}$/;
const LOCAL_PREFIX = 'local:';

const LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  openrouter: 'OpenRouter',
  codex: 'Codex (ChatGPT)',
  routeway: 'Routeway',
};
const SUBSCRIPTION_LABEL = 'Claude subscription';

const bad = (message: string): ApiError => new ApiError(message, 400);

export function labelFor(taken: ModelConnectionRow[], provider: ModelProvider, given: string, subscription = false): string {
  if (given !== '') return given;
  const base = subscription ? SUBSCRIPTION_LABEL : LABELS[provider];
  const count = taken.filter((row) => row.provider === provider && (modelDetailOf(row.detail).subscription === true) === subscription).length;
  return count === 0 ? base : `${base} ${String(count + 1)}`;
}

export function textField(body: Record<string, unknown>, key: string, what: string, max: number): string | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const value = body[key];
  if (typeof value !== 'string') throw bad(`${what} must be a string`);
  if (value.length > max) throw bad(`${what} is too long`);
  return value.trim();
}

export function regionOf(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !REGION_RE.test(value.trim())) throw bad('region must be an AWS region such as us-east-1');
  return value.trim();
}

export function apiKeyOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!API_KEY_RE.test(text)) throw bad('Give the API key: printable characters, 4,096 at most.');
  return text;
}

export function claudeTokenOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!isClaudeToken(text)) throw bad('Give the token that claude setup-token prints: it starts with sk-ant-oat01-.');
  return text;
}

export function flagOf(value: unknown, what: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw bad(`${what} must be true or false`);
  return value;
}

export function connectionArg(body: unknown): string | null {
  const raw = isRecord(body) ? body.connection : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseId(raw);
  if (id === null) throw bad('connection must be a model connection id');
  return id;
}

export function newModelRow(caller: Pick<Caller, 'owner'> & { userId: string }, provider: ModelProvider, label: string, at: string): ModelConnectionRow {
  return {
    id: newId(), owner: caller.owner, provider, label, model: '', region: '', zdr: false, secret: null, detail: null, revision: 1,
    createdBy: `user:${caller.userId}`, createdAt: at, updatedAt: at,
  };
}

export const creator = (caller: Caller): { owner: string; userId: string } => ({ owner: caller.owner, userId: caller.session.userId });

function modelInput(raw: Record<string, unknown>, what: string): string {
  if (raw.model === undefined) return '';
  if (typeof raw.model !== 'string') throw bad(`${what}: the model must be a string`);
  const model = raw.model.trim();
  if (model.length > MODEL_ID_MAX) throw bad(`${what}: the model id is too long`);
  return model;
}

function targetInput(raw: unknown, what: string): RouteTarget {
  if (!isRecord(raw) || typeof raw.connection !== 'string') throw bad(`${what} must be an object with a connection and a model`);
  const connection = raw.connection.trim();
  const model = modelInput(raw, what);
  if (connection.startsWith(LOCAL_PREFIX)) throw bad(`${what} names a Claude login of a box. Those are gone: add a Claude subscription on the organization’s Gateway page.`);
  if (!ID_RE.test(connection)) throw bad(`${what} names no model connection`);
  if (model === '') throw bad(`${what} needs a model`);
  return { connection, model };
}

interface ChainWords {
  missing: string;
  primary: string;
  fallback: string;
  list: string;
}

const MAIN_WORDS: ChainWords = { missing: 'A route needs a primary model. To remove a route, delete it.', primary: 'primary', fallback: 'each fallback', list: 'fallbacks' };
const HELPER_WORDS: ChainWords = { missing: 'Workers need a main model. To let workers use the main models, send helpers: null.', primary: 'helpers.primary', fallback: 'each worker fallback', list: 'worker fallbacks' };

function chainInput(body: Record<string, unknown>, words: ChainWords): RouteChain {
  if (body.primary === null || body.primary === undefined) throw bad(words.missing);
  const primary = targetInput(body.primary, words.primary);
  const raw = body.fallbacks ?? [];
  if (!Array.isArray(raw)) throw bad(`${words.list} must be a list`);
  if (raw.length > FALLBACKS_MAX) throw bad(`A route keeps at most ${String(FALLBACKS_MAX)} ${words.list}.`);
  return { primary, fallbacks: distinctFallbacks(raw.map((entry: unknown) => targetInput(entry, words.fallback))) };
}

export const routeInput = (body: Record<string, unknown>): RouteChain => chainInput(body, MAIN_WORDS);

export function helpersInput(body: Record<string, unknown>): RouteChain | null | undefined {
  if (!Object.hasOwn(body, 'helpers')) return undefined;
  const raw = body.helpers;
  if (raw === null) return null;
  if (!isRecord(raw)) throw bad('helpers must be an object with a primary and fallbacks, or null to let helpers use the main models');
  return chainInput(raw, HELPER_WORDS);
}

const LEVELS_WORD = EFFORT_LEVELS.join(', ');

function levelInput(raw: Record<string, unknown>, key: keyof RouteEffort): RouteEffort {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (!isEffortLevel(value)) throw bad(`effort.${key} must be one of ${LEVELS_WORD}`);
  return { [key]: value };
}

export function effortInput(body: Record<string, unknown>): RouteEffort | null | undefined {
  if (!Object.hasOwn(body, 'effort')) return undefined;
  const raw = body.effort;
  if (raw === null) return null;
  if (!isRecord(raw)) throw bad('effort must be an object with main and helpers, or null for the defaults');
  const other = Object.keys(raw).find((key) => key !== 'main' && key !== 'helpers');
  if (other !== undefined) throw bad(`effort takes main and helpers, not ${other}`);
  return { ...levelInput(raw, 'main'), ...levelInput(raw, 'helpers') };
}
