import type { IncomingMessage } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';

export const MAIN_EFFORT = 'low';
export const SUBAGENT_EFFORT = 'max';
export const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

const SUBAGENT_HEADER = 'x-claude-code-agent-id';
const SUBAGENT_MARK = 'cc_is_subagent=true';
const ABOVE_HIGH = new Set(['xhigh', 'max']);

export type RequestKind = 'main' | 'subagent' | 'other';

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

export function requestKind(req: IncomingMessage, body: Body): RequestKind {
  if (header(req, SUBAGENT_HEADER) !== '' || systemMarksSubagent(body)) return 'subagent';
  return chore(body) ? 'other' : 'main';
}

export function plannedEffort(req: IncomingMessage, body: Body): string | null {
  const current = effortOf(body);
  if (current === '') return null;
  const kind = requestKind(req, body);
  if (kind === 'other') return null;
  const wanted = kind === 'subagent' ? SUBAGENT_EFFORT : MAIN_EFFORT;
  return wanted === current ? null : wanted;
}

export const withEffort = (body: Body, effort: string): Body => ({ ...body, output_config: { ...record(body.output_config), effort } });

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

export function withBlockBinding(body: Body): Body {
  const thinking = body.thinking;
  if (!isRecord(thinking) || thinking.block_binding !== undefined) return body;
  return { ...body, thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
}
