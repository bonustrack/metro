import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';

type Item = Record<string, unknown>;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const messageStart = (id: string, model: string): string =>
  frame('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });

export const messageEnd = (stop: string, usage: Usage): string =>
  frame('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }) + frame('message_stop', { type: 'message_stop' });

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
  const event = raw.event !== '' ? raw.event : stringOf(parsed.type);
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
  if (delta.type === 'text_delta') block.text = stringOf(block.text) + stringOf(delta.text);
  else if (delta.type === 'thinking_delta') block.thinking = stringOf(block.thinking) + stringOf(delta.thinking);
  else if (delta.type === 'signature_delta') block.signature = stringOf(delta.signature);
  else if (delta.type === 'input_json_delta') block.json = stringOf(block.json) + stringOf(delta.partial_json);
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
      input = JSON.parse(stringOf(json) || '{}');
    } catch {
      input = {};
    }
    return { ...rest, input };
  });
  return { ...state.message, content };
}
