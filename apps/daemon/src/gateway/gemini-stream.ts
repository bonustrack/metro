import { isRecord } from '@metro-labs/core/is-record';
import { encodeSignature, newCallId, rememberSignature } from './gemini-translate.js';

type Item = Record<string, unknown>;

interface Open {
  index: number;
  kind: 'text' | 'thinking';
  signature: string | null;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

const STOP_OF: Record<string, string> = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens' };
const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL']);

function usageOf(meta: Item): Usage {
  const cached = num(meta.cachedContentTokenCount);
  return {
    input_tokens: Math.max(0, num(meta.promptTokenCount) - cached),
    output_tokens: num(meta.candidatesTokenCount) + num(meta.thoughtsTokenCount),
    cache_read_input_tokens: cached,
  };
}

export class GeminiStreamTranslator {
  private next = 0;
  private open: Open | null = null;
  private started = false;
  private done = false;
  private toolCalls = 0;
  private usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  private stop = 'end_turn';
  private refusal: string | null = null;
  private readonly model: string;
  private readonly restore: (name: string) => string;

  constructor(model: string, restore: (name: string) => string = (name) => name) {
    this.model = model;
    this.restore = restore;
  }

  get finished(): boolean {
    return this.done;
  }

  private start(): string {
    if (this.started) return '';
    this.started = true;
    return frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_gemini', type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  private closeOpen(): string {
    const block = this.open;
    if (block === null) return '';
    this.open = null;
    const signature = block.kind === 'thinking' ? frame('content_block_delta', { type: 'content_block_delta', index: block.index, delta: { type: 'signature_delta', signature: encodeSignature(block.signature ?? '') } }) : '';
    return signature + frame('content_block_stop', { type: 'content_block_stop', index: block.index });
  }

  private ensure(kind: Open['kind']): string {
    if (this.open?.kind === kind) return '';
    const closed = this.closeOpen();
    this.open = { index: this.next, kind, signature: null };
    this.next += 1;
    const content = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
    return closed + frame('content_block_start', { type: 'content_block_start', index: this.open.index, content_block: content });
  }

  private textPart(part: Item): string {
    const kind = part.thought === true ? 'thinking' : 'text';
    const text = str(part.text);
    let out = this.ensure(kind);
    const block = this.open;
    if (block !== null && str(part.thoughtSignature) !== '') block.signature = str(part.thoughtSignature);
    if (text === '') return out;
    const delta = kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text };
    out += frame('content_block_delta', { type: 'content_block_delta', index: block?.index ?? 0, delta });
    return out;
  }

  private callPart(call: Item, signature: string): string {
    this.toolCalls += 1;
    const id = str(call.id) || newCallId();
    if (signature !== '') rememberSignature(id, signature);
    const index = this.next;
    this.next += 1;
    return (
      this.closeOpen() +
      frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: this.restore(str(call.name)), input: {} } }) +
      frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(isRecord(call.args) ? call.args : {}) } }) +
      frame('content_block_stop', { type: 'content_block_stop', index })
    );
  }

  private part(part: Item): string {
    if (isRecord(part.functionCall)) return this.callPart(part.functionCall, str(part.thoughtSignature));
    if (typeof part.text === 'string') return this.textPart(part);
    return '';
  }

  private candidate(candidate: Item): string {
    const content = isRecord(candidate.content) ? candidate.content : {};
    const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
    const out = parts.map((part) => this.part(part)).join('');
    const finish = str(candidate.finishReason);
    const stop = STOP_OF[finish];
    if (stop !== undefined) this.stop = stop;
    else if (REFUSALS.has(finish)) this.refusal = `Gemini stopped the answer (${finish})`;
    return out;
  }

  push(data: Item): string {
    if (this.done) return '';
    const response = isRecord(data.response) ? data.response : data;
    const out = this.start();
    if (isRecord(response.usageMetadata)) this.usage = usageOf(response.usageMetadata);
    const candidate = Array.isArray(response.candidates) ? response.candidates.find(isRecord) : undefined;
    if (candidate !== undefined) return out + this.candidate(candidate);
    const feedback = isRecord(response.promptFeedback) ? str(response.promptFeedback.blockReason) : '';
    if (feedback !== '') this.refusal = `Gemini blocked the prompt (${feedback})`;
    return out;
  }

  close(error?: string): string {
    if (this.done) return '';
    this.done = true;
    let out = this.start() + this.closeOpen();
    const failure = error ?? this.refusal;
    if (failure !== null && failure !== undefined && this.toolCalls === 0 && this.next === 0)
      return out + frame('error', { type: 'error', error: { type: 'api_error', message: failure } });
    const stop = this.toolCalls > 0 ? 'tool_use' : this.stop;
    out += frame('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: this.usage });
    out += frame('message_stop', { type: 'message_stop' });
    return out;
  }
}
