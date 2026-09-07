import { isRecord } from '../daemon/is-record.js';
import { encodeSignature } from './codex-translate.js';

type Item = Record<string, unknown>;

interface Block {
  index: number;
  kind: 'text' | 'thinking' | 'tool_use';
  deltas: number;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const responseOf = (data: Item): Item => (isRecord(data.response) ? data.response : {});
const itemOf = (data: Item): Item => (isRecord(data.item) ? data.item : {});

function errorKind(code: string): string {
  if (code === 'rate_limit_exceeded' || code === 'usage_limit_reached') return 'rate_limit_error';
  if (code === 'context_length_exceeded' || code === 'invalid_prompt') return 'invalid_request_error';
  if (code === 'insufficient_quota') return 'permission_error';
  return 'api_error';
}

function usageOf(response: Item): Usage {
  const usage = isRecord(response.usage) ? response.usage : {};
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const cached = typeof details.cached_tokens === 'number' ? details.cached_tokens : 0;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    cache_read_input_tokens: cached,
  };
}

const startBlock = (kind: Block['kind'], id: string, name: string): Item =>
  kind === 'text' ? { type: 'text', text: '' } : kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'tool_use', id, name, input: {} };

const messageText = (item: Item): string =>
  Array.isArray(item.content) ? item.content.filter(isRecord).map((part) => str(part.text)).join('') : '';

export class CodexEventTranslator {
  private readonly blocks = new Map<string, Block>();
  private next = 0;
  private started = false;
  private toolCalls = 0;
  private done = false;
  private readonly model: string;
  private readonly restore: (name: string) => string;
  private readonly handlers: Record<string, (data: Item) => string> = {
    'response.created': (d) => this.start(responseOf(d)),
    'response.output_item.added': (d) => this.start({}) + this.itemAdded(itemOf(d)),
    'response.output_text.delta': (d) => this.delta(str(d.item_id), 'text', str(d.delta)),
    'response.reasoning_summary_text.delta': (d) => this.delta(str(d.item_id), 'thinking', str(d.delta)),
    'response.reasoning_summary_part.added': (d) => this.partAdded(str(d.item_id)),
    'response.function_call_arguments.delta': (d) => this.delta(str(d.item_id), 'tool_use', str(d.delta)),
    'response.output_item.done': (d) => this.itemDone(itemOf(d)),
    'response.completed': (d) => this.start(responseOf(d)) + this.completed(responseOf(d)),
    'response.failed': (d) => this.failed(responseOf(d), 'Codex failed the response'),
    'response.incomplete': (d) => this.incomplete(responseOf(d)),
    error: (d) => this.failed({ error: d }, 'Codex stream error'),
  };

  constructor(model: string, restore: (name: string) => string = (name) => name) {
    this.model = model;
    this.restore = restore;
  }

  get finished(): boolean {
    return this.done;
  }

  private open(key: string, kind: Block['kind'], id = '', name = ''): string {
    const block: Block = { index: this.next, kind, deltas: 0 };
    this.next += 1;
    this.blocks.set(key, block);
    return frame('content_block_start', { type: 'content_block_start', index: block.index, content_block: startBlock(kind, id, name) });
  }

  private start(response: Item): string {
    if (this.started) return '';
    this.started = true;
    return frame('message_start', {
      type: 'message_start',
      message: {
        id: str(response.id) || 'msg_codex',
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private openCall(key: string, item: Item): string {
    this.toolCalls += 1;
    return this.open(key, 'tool_use', str(item.call_id) || key, this.restore(str(item.name)));
  }

  private itemAdded(item: Item): string {
    const key = str(item.id) || String(this.next);
    if (item.type === 'function_call') return this.openCall(key, item);
    if (item.type === 'reasoning') return this.open(key, 'thinking');
    return '';
  }

  private partAdded(key: string): string {
    const block = this.blocks.get(key);
    return block !== undefined && block.deltas > 0 ? this.delta(key, 'thinking', '\n\n') : '';
  }

  private delta(key: string, kind: Block['kind'], text: string): string {
    const opened = this.blocks.has(key) ? '' : this.open(key, kind);
    const block = this.blocks.get(key);
    if (block === undefined) return opened;
    block.deltas += 1;
    const delta =
      kind === 'tool_use' ? { type: 'input_json_delta', partial_json: text } : kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text };
    return opened + frame('content_block_delta', { type: 'content_block_delta', index: block.index, delta });
  }

  private stop(key: string): string {
    const block = this.blocks.get(key);
    if (block === undefined) return '';
    this.blocks.delete(key);
    return frame('content_block_stop', { type: 'content_block_stop', index: block.index });
  }

  private reasoningDone(key: string, item: Item): string {
    const opened = this.blocks.has(key) ? '' : this.open(key, 'thinking');
    const block = this.blocks.get(key);
    if (block === undefined || typeof item.encrypted_content !== 'string') return opened + this.stop(key);
    const signature = encodeSignature({ id: key, encrypted_content: item.encrypted_content });
    return opened + frame('content_block_delta', { type: 'content_block_delta', index: block.index, delta: { type: 'signature_delta', signature } }) + this.stop(key);
  }

  private callDone(key: string, item: Item): string {
    let out = this.blocks.has(key) ? '' : this.openCall(key, item);
    if (this.blocks.get(key)?.deltas === 0 && str(item.arguments) !== '') out += this.delta(key, 'tool_use', str(item.arguments));
    return out + this.stop(key);
  }

  private itemDone(item: Item): string {
    const key = str(item.id);
    if (item.type === 'reasoning') return this.reasoningDone(key, item);
    if (item.type === 'function_call') return this.callDone(key, item);
    if (item.type === 'message' && !this.blocks.has(key) && messageText(item) !== '') return this.delta(key, 'text', messageText(item)) + this.stop(key);
    return this.stop(key);
  }

  private completed(response: Item, forced: string | null = null): string {
    this.done = true;
    let out = '';
    for (const key of [...this.blocks.keys()]) out += this.stop(key);
    const stop = forced ?? (this.toolCalls > 0 ? 'tool_use' : 'end_turn');
    out += frame('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: usageOf(response) });
    return out + frame('message_stop', { type: 'message_stop' });
  }

  private incomplete(response: Item): string {
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
    if (details.reason === 'max_output_tokens') return this.start(response) + this.completed(response, 'max_tokens');
    return this.failed(response, `Codex left the response incomplete (${str(details.reason) || 'no reason given'})`);
  }

  private failed(response: Item, fallback: string): string {
    this.done = true;
    const error = isRecord(response.error) ? response.error : {};
    return frame('error', { type: 'error', error: { type: errorKind(str(error.code)), message: str(error.message) || fallback } });
  }

  push(event: string, data: Item): string {
    const handler = this.handlers[event];
    return handler === undefined ? '' : handler(data);
  }

  close(message = 'Codex ended the stream before completing the response'): string {
    if (this.done) return '';
    this.done = true;
    return frame('error', { type: 'error', error: { type: 'api_error', message } });
  }
}

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private pending = '';

  push(chunk: string): SseEvent[] {
    this.pending += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const at = this.pending.indexOf('\n\n');
      if (at < 0) break;
      const raw = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 2);
      let event = '';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}

export function parseEvent(raw: SseEvent): { event: string; data: Item } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const event = raw.event !== '' ? raw.event : str(parsed.type);
  return event === '' ? null : { event, data: parsed };
}

interface Assembled {
  message: Item;
  blocks: Item[];
}

const FOLDS: Record<string, (state: Assembled, data: Item) => void> = {
  message_start: (state, data) => {
    if (isRecord(data.message)) state.message = { ...data.message };
  },
  content_block_start: (state, data) => {
    if (isRecord(data.content_block)) state.blocks.push({ ...data.content_block });
  },
  content_block_delta: (state, data) => {
    if (isRecord(data.delta)) applyDelta(state.blocks[typeof data.index === 'number' ? data.index : -1], data.delta);
  },
  message_delta: (state, data) => {
    if (isRecord(data.delta)) state.message.stop_reason = data.delta.stop_reason ?? null;
    if (isRecord(data.usage)) state.message.usage = data.usage;
  },
  error: (state, data) => {
    state.message = { type: 'error', error: data.error };
  },
};

function foldFrame(state: Assembled, event: string, data: Item): void {
  FOLDS[event]?.(state, data);
}

function applyDelta(block: Item | undefined, delta: Item): void {
  if (block === undefined) return;
  if (delta.type === 'text_delta') block.text = str(block.text) + str(delta.text);
  else if (delta.type === 'thinking_delta') block.thinking = str(block.thinking) + str(delta.thinking);
  else if (delta.type === 'signature_delta') block.signature = str(delta.signature);
  else if (delta.type === 'input_json_delta') block.json = str(block.json) + str(delta.partial_json);
}

export function assembleMessage(frames: string): Item {
  const state: Assembled = { message: {}, blocks: [] };
  for (const raw of new SseParser().push(frames)) {
    const parsed = parseEvent(raw);
    if (parsed !== null) foldFrame(state, parsed.event, parsed.data);
  }
  if (state.message.type === 'error') return state.message;
  const content = state.blocks.map((block) => {
    if (block.type !== 'tool_use') return block;
    const { json, ...rest } = block;
    let input: unknown = {};
    try {
      input = JSON.parse(str(json) || '{}');
    } catch {
      input = {};
    }
    return { ...rest, input };
  });
  return { ...state.message, content };
}
