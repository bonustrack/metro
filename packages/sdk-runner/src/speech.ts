import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isRecord } from '@metro-labs/core/is-record';
import type { InputKind } from './inbox.js';
import { startedCommand, uuidsOf } from './session-watch.js';

export interface SpeechSink {
  say(text: string): void;
  done(): void;
  stalled?(): void;
}


function textDelta(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) return null;
  return event.delta.type === 'text_delta' && typeof event.delta.text === 'string' ? event.delta.text : null;
}

export class SpeechRouter {
  private answering: string[] = [];
  private speaking = false;
  private live = false;

  constructor(
    private readonly kindOf: (uuid: string) => InputKind | undefined,
    private readonly sink: SpeechSink,
  ) {}

  get callLive(): boolean {
    return this.live;
  }

  get talking(): boolean {
    return this.speaking;
  }

  setCallLive(on: boolean): void {
    this.live = on;
    if (!on) this.endTurn();
  }

  observe(message: SDKMessage): void {
    const m: Record<string, unknown> = { ...message };
    if (m.type === 'result') {
      this.endTurn();
      this.answering = [];
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') this.endTurn();
    const started = startedCommand(m);
    if (started !== null) this.answer([started]);
    if (m.parent_tool_use_id === null) this.mainThread(m);
  }

  private answer(uuids: readonly string[]): void {
    this.answering = [...new Set([...this.answering, ...uuids])];
  }

  private mainThread(m: Record<string, unknown>): void {
    if (m.type !== 'stream_event' && m.type !== 'assistant') return;
    const uuids = uuidsOf(m);
    if (uuids !== null) this.answer(uuids);
    const text = m.type === 'stream_event' ? textDelta(m.event) : null;
    if (text === null || text === '' || !this.speaks()) return;
    this.speaking = true;
    this.sink.say(text);
  }

  private speaks(): boolean {
    if (!this.live) return false;
    if (this.answering.length === 0) return true;
    return this.answering.some((uuid) => this.kindOf(uuid) === 'call');
  }

  private endTurn(): void {
    if (!this.speaking) return;
    this.speaking = false;
    this.sink.done();
  }
}
