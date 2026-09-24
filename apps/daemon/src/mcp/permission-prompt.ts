import { isRecord } from '@metro-labs/core/is-record';
import { connectorToolOf } from '../connectors/gates.js';

export interface PermissionParams {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

const METRO_TOOL = /^mcp__metro__(.+)$/;
const FIELD_MAX = 300;
const LEAD = ['text', 'emoji', 'name', 'bio', 'question', 'message_id', 'query', 'from'];
const PLACE = new Set(['line', 'account', 'station']);

const shorten = (text: string, max = FIELD_MAX): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function valueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length > 0 ? `${String(value.length)} item(s)` : undefined;
  return undefined;
}

function channelOf(input: Record<string, unknown>): string | undefined {
  const line = typeof input.line === 'string' ? input.line : '';
  const parts = line.split('/');
  if (line.startsWith('metro://') && parts[2] !== undefined) {
    const where = parts.slice(4).join('/');
    return where === '' ? parts[2] : `${parts[2]} · ${where}`;
  }
  return typeof input.station === 'string' && input.station !== '' ? input.station : undefined;
}

function metroLines(tool: string, input: Record<string, unknown>): string[] {
  const lines = [`Approval needed: ${tool}`];
  const channel = channelOf(input);
  if (channel !== undefined) lines.push(`Channel: ${channel}`);
  const keys = [...LEAD, ...Object.keys(input).filter((k) => !LEAD.includes(k))];
  for (const key of keys) {
    if (PLACE.has(key)) continue;
    const text = key === 'attachments' && Array.isArray(input.attachments) ? `${String(input.attachments.length)} file(s)` : valueText(input[key]);
    if (text !== undefined) lines.push(`${key === 'text' ? 'Text' : key}: ${key === 'text' ? `"${shorten(text)}"` : shorten(text)}`);
  }
  return lines;
}

const ARGS_MAX = 8;

function argText(value: unknown): string | undefined {
  const plain = valueText(value);
  if (plain !== undefined || value === null || typeof value !== 'object') return plain;
  return JSON.stringify(value);
}

function connectorLines(name: string, tool: string, input: Record<string, unknown> | undefined): string[] {
  const lines = [`Approval needed: ${tool}`, `Connector: ${name}`];
  const args = Object.entries(input ?? {}).flatMap(([key, value]) => {
    const text = argText(value);
    return text === undefined ? [] : [`${key}: ${shorten(text)}`];
  });
  lines.push(...args.slice(0, ARGS_MAX));
  if (args.length > ARGS_MAX) lines.push(`(${String(args.length - ARGS_MAX)} more)`);
  return lines;
}

function parsedPreview(preview: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(preview);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function promptBody(params: PermissionParams): string {
  const answer = `Reply "yes ${params.request_id}" or "no ${params.request_id}"`;
  const metro = METRO_TOOL.exec(params.tool_name)?.[1];
  const input = parsedPreview(params.input_preview);
  if (metro !== undefined && input !== undefined) return `${metroLines(metro, input).join('\n')}\n\n${answer}`;
  const connector = connectorToolOf(params.tool_name);
  if (connector !== undefined) return `${connectorLines(connector.gate.name, connector.tool, input).join('\n')}\n\n${answer}`;
  return (
    `Claude wants to run ${params.tool_name}: ${params.description}\n` +
    (params.input_preview ? `\n${params.input_preview}\n` : '') +
    `\n${answer}`
  );
}
