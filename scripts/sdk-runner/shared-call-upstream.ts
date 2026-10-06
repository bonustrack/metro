import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { isRecord } from '../../packages/core/src/is-record.js';

export interface ToolBlock { type: 'tool_use'; name: string; input: Record<string, unknown> }
export type Block = { type: 'text'; text: string } | ToolBlock;
export interface ModelRequest { at: number; worker: boolean; text: string; body: Record<string, unknown> }
export const STORY = 'A little fox followed the moon home. The garden gate was open, and everyone was waiting.';

export function texts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(texts).join('\n');
  if (!isRecord(value)) return '';
  return [value.text, value.content].map(texts).filter(Boolean).join('\n');
}

export function attributes(text: string, tag: string): Record<string, string> {
  const match = new RegExp(`<${tag}\\s([^>]+)>`, 'g');
  const headers = [...text.matchAll(match)].map((header) => Object.fromEntries([...header[1].matchAll(/([\w_]+)="([^"]*)"/g)].map((part) => [part[1], part[2]])));
  return headers.findLast((header) => header.line?.startsWith('metro://')) ?? {};
}

const send = (input: Record<string, unknown>): Block[] => [{ type: 'tool_use', name: 'mcp__metro__send', input }];
const quiet = (): Block[] => [{ type: 'text', text: 'Silent fixture assistant output.' }];

export function speechInput(text: string, reply: string): Record<string, unknown> {
  const call = attributes(text, 'call');
  const chat = attributes(text, 'channel');
  return {
    line: call.line ?? chat.line, text: reply,
    speech: { callId: call.callId ?? chat.call_id, generation: call.generation ?? chat.call_generation, sourceId: call.sourceId ?? chat.call_source_id },
  };
}

function replyFor(text: string): Block[] {
  if (text.includes('task-notification') || text.includes('Its speech targets are invalid')) return quiet();
  if (text.includes('FIXTURE_DELEGATE')) return [{ type: 'tool_use', name: 'Agent', input: {
    description: 'Fixture background task', prompt: 'FIXTURE_WORKER: finish the local fixture task.', subagent_type: 'general-purpose', run_in_background: true,
  } }];
  if (text.includes('FIXTURE_APPROVAL')) return [{ type: 'tool_use', name: 'Agent', input: {
    description: 'Fixture speech approval', prompt: `FIXTURE_APPROVAL_WORKER ${JSON.stringify(speechInput(text, 'Approved fixture speech.'))}`,
    subagent_type: 'general-purpose', run_in_background: true,
  } }];
  if (text.includes('FIXTURE_STORY')) return send(speechInput(text, STORY));
  if (text.includes('FIXTURE_VOICE') || text.includes('FIXTURE_HOLD_CALL')) return send(speechInput(text, 'Voice fixture answer.'));
  const chat = attributes(text, 'channel');
  if (chat.line && text.includes('FIXTURE_CHAT')) return send({ line: chat.line, text: /FIXTURE_CHAT[\w-]*/.exec(text)?.[0] ?? 'FIXTURE_CHAT' });
  return quiet();
}

export function stream(res: ServerResponse, model: string, blocks: Block[], inputTokens = 50): void {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const write = (event: string, data: Record<string, unknown>): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  };
  write('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      write('content_block_start', { index, content_block: { type: 'text', text: '' } });
      write('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      write('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${randomUUID()}`, name: block.name, input: {} } });
      write('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    write('content_block_stop', { index });
  });
  write('message_delta', { delta: { stop_reason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
  write('message_stop', {});
  res.end();
}

export async function listen(server: Server): Promise<string> {
  const port = 10_000 + Math.floor(Math.random() * 19_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${port}`;
}

export class SharedUpstream {
  readonly seen: ModelRequest[] = [];
  readonly held = new Map<string, () => void>();
  readonly failures: string[] = [];
  private readonly answered = new Set<string>();
  inputTokens = 50;
  holdCompaction = false;
  script?: (request: ModelRequest) => Promise<Block[]>;
  base = '';
  private readonly server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      try { this.handle((req.url ?? '').split('?')[0], Buffer.concat(chunks).toString(), res); }
      catch (err) {
        this.failures.push(String(err));
        res.writeHead(500).end(String(err));
      }
    });
  });

  async start(): Promise<void> { this.base = await listen(this.server); }

  release(name: string): void {
    const resume = this.held.get(name);
    assert.ok(resume, `Expected held upstream request: ${name}`);
    this.held.delete(name);
    resume();
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  private takeInputs(text: string): string[] {
    const inputs: string[] = [];
    for (const match of text.matchAll(/<(channel|call)\s[^>]*>[\s\S]*?<\/\1>/g)) {
      const header = attributes(match[0], match[1]);
      const source = header.sourceId ?? header.message_id;
      if (!header.line?.startsWith('metro://') || source === undefined) continue;
      const key = JSON.stringify([match[1], header.line, header.generation, source]);
      if (this.answered.has(key)) continue;
      this.answered.add(key);
      inputs.push(match[0]);
    }
    return inputs;
  }

  private handle(path: string | undefined, raw: string, res: ServerResponse): void {
    if (path?.endsWith('/count_tokens')) { res.writeHead(200).end(JSON.stringify({ input_tokens: this.inputTokens })); return; }
    if (path?.endsWith('/models')) { res.writeHead(200).end(JSON.stringify({ data: [], has_more: false })); return; }
    if (path?.endsWith('/api/hello')) { res.writeHead(200).end(); return; }
    assert.ok(path?.endsWith('/messages'), `Unexpected SDK upstream path: ${String(path)}`);
    const body: unknown = JSON.parse(raw);
    assert.ok(isRecord(body));
    assert.ok(Array.isArray(body.messages));
    const messages: unknown[] = body.messages;
    const lastAssistant = messages.findLastIndex((message) => isRecord(message) && message.role === 'assistant');
    const fresh = messages.slice(lastAssistant + 1);
    const text = texts(fresh);
    const first = texts(messages[0]);
    const worker = first.includes('FIXTURE_WORKER') || first.includes('FIXTURE_APPROVAL_WORKER');
    const model = typeof body.model === 'string' ? body.model : 'fixture-model';
    const request = { at: Date.now(), text, worker, body };
    this.seen.push(request);
    if (this.script !== undefined) {
      this.script(request).then((blocks) => {
        if (body.stream === true) stream(res, model, blocks, this.inputTokens);
        else if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
          content: blocks.map((block) => block.type === 'tool_use' ? { ...block, id: `toolu_${randomUUID()}` } : block),
          stop_reason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null, usage: { input_tokens: this.inputTokens, output_tokens: 7 },
        }));
      }).catch((err: unknown) => {
        this.failures.push(String(err));
        if (!res.destroyed) res.writeHead(500).end(String(err));
      });
      return;
    }
    const hasResult = JSON.stringify(fresh).includes('"tool_result"');
    const compact = /Your task is to create a detailed summary|Please provide a detailed summary/i.test(text) && !worker;
    const inbound = compact || worker ? [] : this.takeInputs(text);
    let blocks = compact ? [{ type: 'text' as const, text: 'Fixture compacted summary. The owner used the local shared call fixture.' }] : inbound.length > 0 ? inbound.flatMap(replyFor) : quiet();
    if (worker) {
      blocks = first.includes('FIXTURE_APPROVAL_WORKER') && !hasResult
        ? send(JSON.parse(first.slice(first.indexOf('FIXTURE_APPROVAL_WORKER ') + 'FIXTURE_APPROVAL_WORKER '.length).split('\n')[0]) as Record<string, unknown>)
        : [{ type: 'text', text: 'Fixture worker completed silently.' }];
    }
    const respond = (): void => {
      if (body.stream === true) stream(res, model, blocks, this.inputTokens);
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Fixture compacted summary.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: this.inputTokens, output_tokens: 7 },
      }));
    };
    const hold = compact && this.holdCompaction ? 'compaction' : worker && first.includes('FIXTURE_WORKER') && !hasResult ? 'worker'
      : /FIXTURE_HOLD_[A-Z_]+/.exec(inbound.join('\n'))?.[0];
    if (hold !== undefined) this.held.set(hold, respond);
    else respond();
  }
}
