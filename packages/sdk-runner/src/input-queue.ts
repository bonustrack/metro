import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunnerInput } from '@metro-labs/core/runner-activity';

type InputKind = RunnerInput['kind'];

const LANES: readonly InputKind[] = ['chat', 'call', 'note'];
const CAPS: Record<InputKind, number> = { chat: 100, call: 32, note: 16 };
const BYTES_MAX = 4 * 1024 * 1024;
const INPUT_MAX = 256 * 1024;

interface Queued {
  kind: InputKind;
  message: SDKUserMessage;
  bytes: number;
  at: number;
}

export class InputQueue {
  private readonly items: Queued[] = [];
  private bytes = 0;
  private lane = 0;
  private first: string | null = null;

  prefer(uuid: string): void { this.first = uuid; }

  get size(): number { return this.items.length; }
  get oldest(): number | null { return this.items.reduce<number | null>((at, item) => at === null ? item.at : Math.min(at, item.at), null); }

  check(kind: InputKind, text: string): void {
    const bytes = Buffer.byteLength(text);
    if (bytes > INPUT_MAX || this.bytes + bytes > BYTES_MAX || this.items.filter((item) => item.kind === kind).length >= CAPS[kind]) {
      throw new Error('The SDK input queue is full. Wait for queued work to finish before retrying.');
    }
  }

  push(kind: InputKind, message: SDKUserMessage, text: string, at: number): void {
    const bytes = Buffer.byteLength(text);
    this.items.push({ kind, message, bytes, at });
    this.bytes += bytes;
  }

  take(): SDKUserMessage | undefined {
    if (this.first !== null) {
      const index = this.items.findIndex((item) => item.message.uuid === this.first);
      this.first = null;
      if (index >= 0) return this.remove(index)?.message;
    }
    for (let i = 0; i < LANES.length; i += 1) {
      const lane = (this.lane + i) % LANES.length;
      const index = this.items.findIndex((item) => item.kind === LANES[lane]);
      if (index < 0) continue;
      this.lane = (lane + 1) % LANES.length;
      return this.remove(index)?.message;
    }
    return undefined;
  }

  cancel(uuids: ReadonlySet<string>): void {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const uuid = this.items[index]?.message.uuid;
      if (uuid !== undefined && uuids.has(uuid)) this.remove(index);
    }
  }

  private remove(index: number): Queued | undefined {
    const [item] = this.items.splice(index, 1);
    if (item !== undefined) this.bytes -= item.bytes;
    return item;
  }
}
