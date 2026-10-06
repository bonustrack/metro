import { isRecord } from '@metro-labs/core/is-record';

const METRO_TOOL = /^mcp__metro__(.+)$/;

export const uuidsOf = (m: Record<string, unknown>): string[] | null => {
  if (Array.isArray(m.user_message_uuids)) return m.user_message_uuids.filter((u): u is string => typeof u === 'string');
  return typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : null;
};

export const startedCommand = (m: Record<string, unknown>): string | null =>
  m.type === 'command_lifecycle' && m.state === 'started' && typeof m.command_uuid === 'string' ? m.command_uuid : null;

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

function contextOf(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
}

function toolResultIds(message: unknown): string[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord).filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string').map((b) => String(b.tool_use_id));
}


export class SessionWatch {
  private readonly writes = new Set<string>();
  private readonly idle: (() => void)[] = [];
  private readonly compacted: (() => void)[] = [];
  private compactingNow = false;
  private busy = false;
  private sessionStateSeen = false;
  private lastContext = 0;
  private streamUsage: Record<string, unknown> = {};

  constructor(private readonly readOnly: (tool: string) => boolean) {}

  get compacting(): boolean {
    return this.compactingNow;
  }

  get context(): number {
    return this.lastContext;
  }

  get writing(): boolean {
    return this.writes.size > 0;
  }

  get safe(): boolean { return !this.busy && !this.writing && !this.compacting; }

  dispatched(): void { this.busy = true; }
  restoreContext(context: number): void { this.lastContext = context; }

  observe(m: Record<string, unknown>): void {
    if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined) return;
    this.lifecycle(m);
    if (m.type === 'assistant' && isRecord(m.message)) this.assistant(m.message);
    else if (m.type === 'stream_event' && isRecord(m.event)) this.stream(m.event);
    else if (m.type === 'user') for (const id of toolResultIds(m.message)) this.done(id);
  }

  whenNotWriting(): Promise<void> {
    return this.writing ? new Promise((resolve) => { this.idle.push(resolve); }) : Promise.resolve();
  }

  whenNotCompacting(): Promise<void> {
    return this.compactingNow ? new Promise((resolve) => { this.compacted.push(resolve); }) : Promise.resolve();
  }

  private lifecycle(m: Record<string, unknown>): void {
    if (m.type === 'system') this.system(m);
    else if (m.type === 'result' && !this.sessionStateSeen) {
      this.busy = typeof m.queued_turn_count === 'number' && m.queued_turn_count > 0;
      this.settle();
    }
    if (m.type === 'assistant' || m.type === 'stream_event' || startedCommand(m) !== null) this.busy = true;
  }

  private system(m: Record<string, unknown>): void {
    if (m.subtype === 'session_state_changed') {
      this.sessionStateSeen = true;
      if (m.state === 'running' || m.state === 'requires_action') this.busy = true;
      else if (m.state === 'idle') { this.busy = false; this.settle(); }
    } else if (m.subtype === 'status') this.setCompacting(m.status === 'compacting');
    else if (m.subtype === 'compact_boundary') {
      this.setCompacting(false);
      this.lastContext = 0;
      this.streamUsage = {};
    }
  }

  private stream(event: Record<string, unknown>): void {
    if (event.type === 'message_start' && isRecord(event.message)) {
      this.streamUsage = isRecord(event.message.usage) ? event.message.usage : {};
    } else if (event.type === 'message_delta' && isRecord(event.usage)) {
      this.streamUsage = { ...this.streamUsage, ...event.usage };
    } else return;
    this.lastContext = contextOf(this.streamUsage) || this.lastContext;
  }

  private setCompacting(on: boolean): void {
    this.compactingNow = on;
    if (!on) for (const resume of this.compacted.splice(0)) resume();
  }

  private assistant(message: Record<string, unknown>): void {
    this.lastContext = contextOf(message.usage) || this.lastContext;
    if (!Array.isArray(message.content)) return;
    for (const block of message.content.filter(isRecord)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
      const tool = METRO_TOOL.exec(block.name)?.[1];
      if (tool !== undefined && !this.readOnly(tool)) this.writes.add(block.id);
    }
  }

  private done(id: string): void {
    if (this.writes.delete(id) && this.writes.size === 0) this.wake();
  }

  private settle(): void {
    if (this.writes.size === 0) return;
    this.writes.clear();
    this.wake();
  }

  private wake(): void {
    for (const resume of this.idle.splice(0)) resume();
  }
}
