import assert from 'node:assert/strict';
import { isRecord } from '../../packages/core/src/is-record.js';
import { attributes, speechInput, texts, type Block, type ModelRequest } from './shared-call-upstream.js';

export const WORKLOAD = { thinkMs: 2_500, writeMs: 1_500, speechMs: 350, loopWrites: 5, workerOffsets: [200, 2_200, 4_200, 6_200, 8_200], humanOffsets: [100, 250, 400] };
export const HUMAN = ['LATENCY_HUMAN_VOICE', 'LATENCY_HUMAN_CHAT', 'LATENCY_HUMAN_SPEAK'] as const;
export interface RequestTiming { at: number; respondedAt: number | null; kind: string; text: string; humans: string[] }
const message = (text: string): Block[] => [{ type: 'text', text }];
const send = (input: Record<string, unknown>): Block => ({ type: 'tool_use', name: 'mcp__metro__send', input });

export class LatencyModel {
  readonly requests: RequestTiming[] = [];
  readonly workers = new Map<number, () => void>();
  private readonly answered = new Set<string>();
  private remaining = 0;
  private writes = 0;
  private empty: string | null = null;

  constructor(private readonly line: string) {}

  releaseWorker(id: number): void {
    const release = this.workers.get(id);
    assert.ok(release, `Real SDK worker ${id} must be waiting`);
    this.workers.delete(id);
    release();
  }

  async reply(request: ModelRequest): Promise<Block[]> {
    const row: RequestTiming = { at: request.at, respondedAt: null, kind: 'quiet', text: request.text, humans: [] };
    this.requests.push(row);
    const first = texts(Array.isArray(request.body.messages) ? request.body.messages[0] : undefined);
    const worker = /LATENCY_WORKER_(\d+)/.exec(first);
    let blocks: Block[];
    if (worker !== null) {
      request.worker = true;
      row.kind = `worker-${worker[1]}`;
      await new Promise<void>((resolve) => { this.workers.set(Number(worker[1]), resolve); });
      blocks = message(`LATENCY_WORKER_${worker[1]} finished its assigned fixture work.`);
    } else {
      const messages: unknown[] = Array.isArray(request.body.messages) ? request.body.messages : [];
      const lastAssistant = messages.findLastIndex((value) => isRecord(value) && value.role === 'assistant');
      const hasResult = JSON.stringify(messages.slice(lastAssistant + 1)).includes('"tool_result"');
      blocks = this.front(request.text, row, hasResult);
      await Bun.sleep(WORKLOAD.thinkMs);
    }
    row.respondedAt = Date.now();
    process.stdout.write(`${JSON.stringify({ check: 'latency model response', ...row, text: row.kind.endsWith('-continuation') ? row.text : undefined })}\n`);
    return blocks;
  }

  private humans(text: string, row: RequestTiming): Block[] {
    const blocks: Block[] = [];
    for (const match of text.matchAll(/<(channel|call)\s[^>]*>[\s\S]*?<\/\1>/g)) {
      const wrapped = match[0];
      const header = attributes(wrapped, match[1]);
      if (header.line !== this.line) continue;
      const marker = /LATENCY_(?:HUMAN_(?:VOICE|CHAT|SPEAK)|SILENT|RACE)/.exec(wrapped)?.[0];
      if (marker === undefined || this.answered.has(marker)) continue;
      this.answered.add(marker);
      row.humans.push(marker);
      blocks.push(send(marker === 'LATENCY_HUMAN_CHAT' ? { line: this.line, text: `${marker}_REPLY` } : speechInput(wrapped, `${marker}_REPLY`)));
      this.empty = marker === 'LATENCY_SILENT' ? 'silent' : marker === 'LATENCY_RACE' ? 'failed-send' : null;
    }
    return blocks;
  }

  private front(text: string, row: RequestTiming, hasResult: boolean): Block[] {
    if (text.includes('LATENCY_LAUNCH') && !hasResult) {
      row.kind = 'launch';
      return [...WORKLOAD.workerOffsets.map((_offset, id): Block => ({ type: 'tool_use', name: 'Agent', input: {
        description: `Latency worker ${id}`, prompt: `LATENCY_WORKER_${id}: complete the isolated fake workload.`, subagent_type: 'general-purpose', run_in_background: true,
      } })), send({ line: this.line, text: 'LATENCY_LAUNCHED' })];
    }
    if (text.includes('LATENCY_PRESSURE') && this.writes === 0) this.remaining = WORKLOAD.loopWrites;
    const blocks = this.humans(text, row);
    if (blocks.length > 0) row.kind = 'human';
    if (this.remaining > 0) {
      this.remaining--;
      this.writes++;
      blocks.push(send({ line: this.line, text: `LATENCY_LOOP_${this.writes}` }));
      row.kind = blocks.length > 1 ? 'human-and-loop' : 'loop';
    }
    if (blocks.length > 0) return blocks;
    if (text.includes('LATENCY_HOLD_RACE') && !this.answered.has('LATENCY_HOLD_RACE')) {
      this.answered.add('LATENCY_HOLD_RACE');
      this.empty = null;
      row.kind = 'race-write';
      return [send({ line: this.line, text: 'LATENCY_RACE_WRITE' })];
    }
    for (const mode of ['empty', 'read', 'refused']) {
      const marker = `LATENCY_CONTROL_${mode.toUpperCase()}`;
      if (text.includes(marker) && !this.answered.has(marker)) {
        this.answered.add(marker);
        this.empty = mode;
        row.kind = `${mode}-initial`;
        if (mode === 'refused') {
          const expired = this.requests.find((request) => request.humans.includes('LATENCY_RACE'));
          assert.ok(expired);
          return [send(speechInput(expired.text, 'LATENCY_REFUSED_REPLY'))];
        }
        return mode === 'read' ? [{ type: 'tool_use', name: 'mcp__metro__list_accounts', input: {} }] : [];
      }
    }
    if (text.includes('Its speech targets are invalid')) this.empty = null;
    if (this.empty !== null) {
      row.kind = `${this.empty}-${text.includes('[Your previous response had no visible output.') ? 'continuation' : hasResult ? 'tool-result' : 'empty'}`;
      return [];
    }
    if (text.includes('task-notification')) row.kind = 'worker-completion';
    return message('Fixture bookkeeping finished. No additional user action is needed.');
  }
}
