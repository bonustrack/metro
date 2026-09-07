import { createHash } from 'node:crypto';
import { isRecord } from '../daemon/is-record.js';

export const SIGNATURE_PREFIX = 'metro-codex:';
const DEFAULT_EFFORT = 'medium';
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const EFFORT_ALIAS: Record<string, string> = { max: 'xhigh' };
const IMAGE_NOTE = '[an image was attached here; this model cannot see it]';
const NAME_MAX = 64;
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const HASH_LEN = 8;

type Item = Record<string, unknown>;

export interface TranslateOptions {
  promptCacheKey: string;
  names?: ToolNames;
}

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: Item[];
  tools: Item[];
  tool_choice: unknown;
  parallel_tool_calls: boolean;
  reasoning: { effort: string; summary: string };
  store: false;
  stream: true;
  include: string[];
  prompt_cache_key: string;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

export function codexToolName(name: string): string {
  if (name.length <= NAME_MAX && NAME_RE.test(name)) return name;
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = createHash('sha256').update(name).digest('hex').slice(0, HASH_LEN);
  return `${clean.slice(0, NAME_MAX - HASH_LEN - 1)}_${hash}`;
}

export class ToolNames {
  private readonly original = new Map<string, string>();

  alias(name: string): string {
    const alias = codexToolName(name);
    if (alias !== name) this.original.set(alias, name);
    return alias;
  }

  restore(alias: string): string {
    return this.original.get(alias) ?? alias;
  }
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => textOf(block.text))
    .join('\n');
}

export function systemText(system: unknown): string {
  return blocksText(system).trim();
}

export function encodeSignature(item: Item): string {
  return `${SIGNATURE_PREFIX}${Buffer.from(JSON.stringify(item)).toString('base64url')}`;
}

export function decodeSignature(signature: unknown): Item | null {
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function userPart(block: Item): Item | null {
  if (block.type === 'text') return { type: 'input_text', text: textOf(block.text) };
  if (block.type === 'image' && isRecord(block.source) && block.source.type === 'base64')
    return { type: 'input_image', image_url: `data:${textOf(block.source.media_type)};base64,${textOf(block.source.data)}` };
  return null;
}

const partText = (part: Item): string => (part.type === 'text' ? textOf(part.text) : part.type === 'image' ? IMAGE_NOTE : '');

function resultText(block: Item): string {
  const content = block.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(isRecord).map(partText).filter((t) => t !== '').join('\n') : '';
  return block.is_error === true ? `[tool error] ${text}` : text;
}

function userItems(content: unknown): Item[] {
  if (typeof content === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] }];
  if (!Array.isArray(content)) return [];
  const out: Item[] = [];
  let parts: Item[] = [];
  const flush = (): void => {
    if (parts.length > 0) out.push({ type: 'message', role: 'user', content: parts });
    parts = [];
  };
  for (const block of content.filter(isRecord)) {
    if (block.type === 'tool_result') {
      flush();
      out.push({ type: 'function_call_output', call_id: textOf(block.tool_use_id), output: resultText(block) });
      continue;
    }
    const part = userPart(block);
    if (part !== null) parts.push(part);
  }
  flush();
  return out;
}

function assistantItems(content: unknown, names: ToolNames): Item[] {
  if (typeof content === 'string') return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }];
  if (!Array.isArray(content)) return [];
  const out: Item[] = [];
  for (const block of content.filter(isRecord)) {
    if (block.type === 'text') out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textOf(block.text) }] });
    else if (block.type === 'tool_use')
      out.push({ type: 'function_call', call_id: textOf(block.id), name: names.alias(textOf(block.name)), arguments: JSON.stringify(block.input ?? {}) });
    else if (block.type === 'thinking') {
      const reasoning = decodeSignature(block.signature);
      if (reasoning !== null) out.push({ type: 'reasoning', ...reasoning, summary: [] });
    }
  }
  return out;
}

export function inputItems(messages: unknown, names = new ToolNames()): Item[] {
  const out: Item[] = [];
  if (!Array.isArray(messages)) return out;
  for (const message of messages.filter(isRecord)) {
    if (message.role === 'assistant') out.push(...assistantItems(message.content, names));
    else out.push(...userItems(message.content));
  }
  return out;
}

export function toolItems(tools: unknown, names = new ToolNames()): Item[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(isRecord)
    .filter((tool) => typeof tool.name === 'string' && isRecord(tool.input_schema))
    .map((tool) => ({
      type: 'function',
      name: names.alias(textOf(tool.name)),
      description: textOf(tool.description),
      parameters: tool.input_schema,
      strict: false,
    }));
}

export function toolChoiceOf(choice: unknown, names = new ToolNames()): unknown {
  if (!isRecord(choice)) return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && typeof choice.name === 'string') return { type: 'function', name: names.alias(choice.name) };
  return 'auto';
}

function configuredEffort(body: Item): string | null {
  const config = isRecord(body.output_config) ? body.output_config : {};
  const effort = typeof config.effort === 'string' ? (EFFORT_ALIAS[config.effort] ?? config.effort) : '';
  return EFFORTS.has(effort) ? effort : null;
}

export function effortOf(body: Item): string {
  const configured = configuredEffort(body);
  if (configured !== null) return configured;
  const thinking = isRecord(body.thinking) ? body.thinking : {};
  if (thinking.type === 'disabled') return 'low';
  const budget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 0;
  if (budget > 0 && budget <= 4_000) return 'low';
  if (budget > 16_000) return 'high';
  return DEFAULT_EFFORT;
}

export function toResponsesRequest(body: Item, model: string, opts: TranslateOptions): ResponsesRequest {
  const system = systemText(body.system);
  const names = opts.names ?? new ToolNames();
  return {
    model,
    ...(system === '' ? {} : { instructions: system }),
    input: inputItems(body.messages, names),
    tools: toolItems(body.tools, names),
    tool_choice: toolChoiceOf(body.tool_choice, names),
    parallel_tool_calls: true,
    reasoning: { effort: effortOf(body), summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: opts.promptCacheKey,
  };
}
