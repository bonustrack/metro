import type { IncomingMessage } from 'node:http';
import { EFFORT_DEFAULTS, type RouteEffort } from '@metro-labs/core/effort';
import { isRecord } from '@metro-labs/core/is-record';

export const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

const COMPACT_EFFORT = 'low';
const SUBAGENT_HEADER = 'x-claude-code-agent-id';
const SUBAGENT_MARK = 'cc_is_subagent=true';
const REQUEST_CLASS_HEADER = 'x-claude-code-request-class';
const COMPACTION_CLASS = 'compaction';
const COMPACT_PROMPT = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.';
const ABOVE_HIGH = new Set(['xhigh', 'max']);

export type RequestKind = 'main' | 'subagent' | 'compact' | 'other';

type Body = Record<string, unknown>;

const record = (value: unknown): Body => (isRecord(value) ? value : {});

const effortOf = (body: Body): string => {
  const effort = record(body.output_config).effort;
  return typeof effort === 'string' ? effort : '';
};

function header(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
}

function systemMarksSubagent(body: Body): boolean {
  const system = body.system;
  if (!Array.isArray(system)) return false;
  return system.some((block) => isRecord(block) && typeof block.text === 'string' && block.text.includes(SUBAGENT_MARK));
}

const chore = (body: Body): boolean => record(body.output_config).format !== undefined || record(body.thinking).type === 'disabled';

const messagesOf = (body: Body): unknown[] => (Array.isArray(body.messages) ? body.messages : []);

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []));
}

function asksForSummary(body: Body): boolean {
  const last = messagesOf(body).map(record).findLast((message) => message.role === 'user');
  return textsOf(last?.content).some((text) => text.trimStart().startsWith(COMPACT_PROMPT));
}

export const agentIdOf = (req: IncomingMessage): string => header(req, SUBAGENT_HEADER);

export const helperRequest = (req: IncomingMessage, body: Body): boolean => agentIdOf(req) !== '' || systemMarksSubagent(body);

export const compactionRequest = (req: IncomingMessage, body: Body): boolean => header(req, REQUEST_CLASS_HEADER) === COMPACTION_CLASS || asksForSummary(body);

export function requestKind(req: IncomingMessage, body: Body): RequestKind {
  if (compactionRequest(req, body)) return 'compact';
  if (helperRequest(req, body)) return 'subagent';
  return chore(body) ? 'other' : 'main';
}

const askedEfforts = (body: Body): string[] => [body, ...messagesOf(body).map(record)].map(effortOf).filter((effort) => effort !== '');

function wantedEffort(kind: RequestKind, setting: RouteEffort): string | null {
  if (kind === 'compact') return COMPACT_EFFORT;
  if (kind === 'other') return null;
  const wanted = kind === 'subagent' ? (setting.helpers ?? EFFORT_DEFAULTS.helpers) : (setting.main ?? EFFORT_DEFAULTS.main);
  return wanted === 'asked' ? null : wanted;
}

export function plannedEffort(req: IncomingMessage, body: Body, setting: RouteEffort = {}): string | null {
  const asked = askedEfforts(body);
  if (asked.length === 0) return null;
  const wanted = wantedEffort(requestKind(req, body), setting);
  if (wanted === null) return null;
  return asked.every((effort) => effort === wanted) ? null : wanted;
}

const withOwnEffort = (item: Body, effort: string): Body => (effortOf(item) === '' ? item : { ...item, output_config: { ...record(item.output_config), effort } });

export function withEffort(body: Body, effort: string): Body {
  const top = withOwnEffort(body, effort);
  if (!Array.isArray(body.messages)) return top;
  return { ...top, messages: body.messages.map((message: unknown) => (isRecord(message) ? withOwnEffort(message, effort) : message)) };
}

export function withoutEffort(body: Body): Body {
  const config = Object.fromEntries(Object.entries(record(body.output_config)).filter(([key]) => key !== 'effort'));
  if (Object.keys(config).length > 0) return { ...body, output_config: config };
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'output_config'));
}

export function effortToApply(body: Body): string | null {
  if (chore(body)) return null;
  const effort = effortOf(body);
  return effort === '' ? null : effort;
}

export const cappedEffort = (effort: string): string => (ABOVE_HIGH.has(effort) ? 'high' : effort);

const THINKING_ALWAYS_ON = /claude-(fable|mythos)-5|claude-opus-5-5/;
const REFUSES_THINKING_OFF = '"thinking.type.disabled" is not supported';
const thinkingAlwaysOn = new Set<string>();

export const thinkingOff = (body: Body): boolean => record(body.thinking).type === 'disabled';

const alwaysThinks = (model: string): boolean => THINKING_ALWAYS_ON.test(model) || thinkingAlwaysOn.has(model);

export function withThinkingFor(body: Body, model: string): Body {
  if (!alwaysThinks(model) || !thinkingOff(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'thinking'));
}

export function learnAlwaysThinks(model: string, refusal: string): boolean {
  if (!refusal.includes(REFUSES_THINKING_OFF)) return false;
  thinkingAlwaysOn.add(model);
  return true;
}

export function forgetLearnedThinking(): void {
  thinkingAlwaysOn.clear();
}

export function withBlockBinding(body: Body): Body {
  const thinking = body.thinking;
  if (!isRecord(thinking) || thinking.block_binding !== undefined) return body;
  return { ...body, thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
}
