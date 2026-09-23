import { isRecord } from '@metro-labs/core/is-record';
import { encodeSignature } from './codex-translate.js';
import { errorFrame } from './forward.js';
import { frame, messageEnd, messageStart, type Usage } from './frames.js';
import { stringOf } from './text.js';

type Item = Record<string, unknown>;

interface Block {
  index: number;
  kind: 'text' | 'thinking' | 'tool_use';
  deltas: number;
}

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
  Array.isArray(item.content) ? item.content.filter(isRecord).map((part) => stringOf(part.text)).join('') : '';

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
    'response.output_text.delta': (d) => this.delta(stringOf(d.item_id), 'text', stringOf(d.delta)),
    'response.reasoning_summary_text.delta': (d) => this.delta(stringOf(d.item_id), 'thinking', stringOf(d.delta)),
    'response.reasoning_summary_part.added': (d) => this.partAdded(stringOf(d.item_id)),
    'response.function_call_arguments.delta': (d) => this.delta(stringOf(d.item_id), 'tool_use', stringOf(d.delta)),
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
    return messageStart(stringOf(response.id) || 'msg_codex', this.model);
  }

  private openCall(key: string, item: Item): string {
    this.toolCalls += 1;
    return this.open(key, 'tool_use', stringOf(item.call_id) || key, this.restore(stringOf(item.name)));
  }

  private itemAdded(item: Item): string {
    const key = stringOf(item.id) || String(this.next);
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
    if (this.blocks.get(key)?.deltas === 0 && stringOf(item.arguments) !== '') out += this.delta(key, 'tool_use', stringOf(item.arguments));
    return out + this.stop(key);
  }

  private itemDone(item: Item): string {
    const key = stringOf(item.id);
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
    return out + messageEnd(stop, usageOf(response));
  }

  private incomplete(response: Item): string {
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
    if (details.reason === 'max_output_tokens') return this.start(response) + this.completed(response, 'max_tokens');
    return this.failed(response, `Codex left the response incomplete (${stringOf(details.reason) || 'no reason given'})`);
  }

  private failed(response: Item, fallback: string): string {
    this.done = true;
    const error = isRecord(response.error) ? response.error : {};
    return errorFrame(errorKind(stringOf(error.code)), stringOf(error.message) || fallback);
  }

  push(event: string, data: Item): string {
    const handler = this.handlers[event];
    return handler === undefined ? '' : handler(data);
  }

  close(message = 'Codex ended the stream before completing the response'): string {
    if (this.done) return '';
    this.done = true;
    return errorFrame('api_error', message);
  }
}
