import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CHAT_PARTS_MAX, chatName, clip, PART_TEXT_MAX, TOOL_TEXT_MAX, type ApprovalState, type ChatPart, type TurnEvent } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';

export type Emit = (event: TurnEvent) => void;

const toolInput = (input: unknown): string => {
  if (input === undefined || (isRecord(input) && Object.keys(input).length === 0)) return '';
  return clip(JSON.stringify(input), TOOL_TEXT_MAX);
};

function resultText(content: unknown): string {
  if (typeof content === 'string') return clip(content, TOOL_TEXT_MAX);
  if (!Array.isArray(content)) return '';
  const texts = content.map((block: unknown) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : isRecord(block) ? `[${String(block.type)}]` : ''));
  return clip(texts.join('\n'), TOOL_TEXT_MAX);
}

const deltaText = (delta: unknown): string | null =>
  isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '' ? delta.text : null;

const blocksOf = (message: unknown): Record<string, unknown>[] =>
  isRecord(message) && Array.isArray(message.content) ? message.content.filter(isRecord) : [];

export class ChatParts {
  readonly parts: ChatPart[] = [];
  private readonly streamed = new Set<string>();
  private readonly blocks = new Map<number, number | null>();
  private readonly tools = new Map<string, number>();

  constructor(private readonly emit: Emit) {}

  private put(n: number, part: ChatPart): void {
    this.parts[n] = part;
    this.emit({ t: 'part', n, part });
  }

  private add(part: ChatPart): number | null {
    if (this.parts.length >= CHAT_PARTS_MAX) return null;
    const n = this.parts.length;
    this.put(n, part);
    return n;
  }

  private addTool(id: string, name: string, input: string): void {
    const n = this.add({ type: 'tool', id: chatName(id), name: chatName(name), input, result: null, ok: null });
    if (n !== null) this.tools.set(id, n);
  }

  private started(block: Record<string, unknown>, index: number): void {
    if (block.type === 'text') this.blocks.set(index, this.add({ type: 'text', text: typeof block.text === 'string' ? clip(block.text, PART_TEXT_MAX) : '' }));
    else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') this.addTool(block.id, block.name, '');
    else this.blocks.set(index, null);
  }

  private delta(index: number, delta: unknown): void {
    const text = deltaText(delta);
    const n = this.blocks.get(index) ?? null;
    const part = n === null ? undefined : this.parts[n];
    if (text === null || n === null || part?.type !== 'text') return;
    this.parts[n] = { type: 'text', text: clip(part.text + text, PART_TEXT_MAX) };
    this.emit({ t: 'delta', n, d: text });
  }

  private stream(event: Record<string, unknown>): void {
    const index = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'message_start' && isRecord(event.message) && typeof event.message.id === 'string') {
      this.streamed.add(event.message.id);
      this.blocks.clear();
    } else if (event.type === 'content_block_start' && isRecord(event.content_block)) this.started(event.content_block, index);
    else if (event.type === 'content_block_delta') this.delta(index, event.delta);
  }

  private toolUse(block: Record<string, unknown>): void {
    if (typeof block.id !== 'string' || typeof block.name !== 'string') return;
    const n = this.tools.get(block.id);
    const part = n === undefined ? undefined : this.parts[n];
    if (n === undefined || part?.type !== 'tool') this.addTool(block.id, block.name, toolInput(block.input));
    else this.put(n, { ...part, input: toolInput(block.input) });
  }

  private assistant(message: Record<string, unknown>): void {
    const live = typeof message.id === 'string' && this.streamed.has(message.id);
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_use') this.toolUse(block);
      else if (!live && block.type === 'text' && typeof block.text === 'string' && block.text !== '') this.add({ type: 'text', text: clip(block.text, PART_TEXT_MAX) });
    }
  }

  private toolResult(block: Record<string, unknown>): void {
    const n = typeof block.tool_use_id === 'string' ? this.tools.get(block.tool_use_id) : undefined;
    const part = n === undefined ? undefined : this.parts[n];
    if (n === undefined || part?.type !== 'tool') return;
    this.put(n, { ...part, result: resultText(block.content), ok: block.is_error !== true });
  }

  take(message: SDKMessage): void {
    if (!('parent_tool_use_id' in message) || message.parent_tool_use_id !== null) return;
    if (message.type === 'stream_event' && isRecord(message.event)) this.stream(message.event);
    else if (message.type === 'assistant' && isRecord(message.message)) this.assistant(message.message);
    else if (message.type === 'user') for (const block of blocksOf(message.message)) if (block.type === 'tool_result') this.toolResult(block);
  }

  ask(id: string, tool: string, input: Record<string, unknown>): number | null {
    return this.add({ type: 'approval', id, tool: chatName(tool), input: toolInput(input), state: 'waiting' });
  }

  answered(n: number, state: ApprovalState): void {
    const part = this.parts[n];
    if (part?.type === 'approval') this.put(n, { ...part, state });
  }
}
