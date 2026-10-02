import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isRecord } from '@metro-labs/core/is-record';
import type { InputKind } from './inbox.js';
import { replayedUuid, uuidsOf } from './session-watch.js';

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
    if ((m.type === 'system' && m.subtype === 'init') || m.type === 'result') {
      this.endTurn();
      return;
    }
    if (m.parent_tool_use_id === null) this.mainThread(m);
  }

  private mainThread(m: Record<string, unknown>): void {
    const delivered = replayedUuid(m);
    if (delivered !== null && !this.answering.includes(delivered)) this.answering = [...this.answering, delivered];
    if (m.type !== 'stream_event' && m.type !== 'assistant') return;
    const uuids = uuidsOf(m);
    if (uuids !== null) this.answering = uuids;
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
    this.answering = [];
    if (!this.speaking) return;
    this.speaking = false;
    this.sink.done();
  }
}
