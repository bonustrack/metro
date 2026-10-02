import { isRecord } from '@metro-labs/core/is-record';

const METRO_TOOL = /^mcp__metro__(.+)$/;
const GATE_CAP_MS = 5_000;

export const uuidsOf = (m: Record<string, unknown>): string[] | null => {
  if (Array.isArray(m.user_message_uuids)) return m.user_message_uuids.filter((u): u is string => typeof u === 'string');
  return typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : null;
};

export const replayedUuid = (m: Record<string, unknown>): string | null =>
  m.type === 'user' && m.isReplay === true && m.parent_tool_use_id === null && typeof m.uuid === 'string' ? m.uuid : null;

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
  private compactingNow = false;
  private lastContext = 0;

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

  observe(m: Record<string, unknown>): void {
    if (m.type === 'system') this.system(m);
    else if (m.type === 'result') this.settle();
    if (m.parent_tool_use_id !== null) return;
    if (m.type === 'assistant' && isRecord(m.message)) this.assistant(m.message);
    else if (m.type === 'user') for (const id of toolResultIds(m.message)) this.done(id);
  }

  whenNotWriting(capMs = GATE_CAP_MS): Promise<void> {
    if (!this.writing) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, capMs);
      this.idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private system(m: Record<string, unknown>): void {
    if (m.subtype === 'init') this.settle();
    else if (m.subtype === 'status') this.compactingNow = m.status === 'compacting';
    else if (m.subtype === 'compact_boundary') {
      this.compactingNow = false;
      this.lastContext = 0;
    }
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
