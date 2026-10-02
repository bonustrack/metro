import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface UpstreamRequest {
  t: number;
  model: string;
  worker: boolean;
}

export interface ScriptedUpstream {
  seen: UpstreamRequest[];
  close(): void;
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> };

const WORKER_TASK = 'WORKER-TASK';
const LINE_RE = /line=\\"(metro:\/\/[^"\\]+)\\"/g;

const send = (line: string, text: string): Block[] => [{ type: 'tool_use', name: 'mcp__metro__send', input: { line, text } }];

function answerFor(body: Record<string, unknown>, model: string, lines: string[]): { worker: boolean; blocks: Block[] } {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const worker = JSON.stringify(messages[0] ?? '').includes(WORKER_TASK);
  if (worker) return { worker, blocks: [{ type: 'text', text: `worker done on ${model}` }] };
  const lastAnswer = messages.findLastIndex((m) => typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'assistant');
  const last = JSON.stringify(messages.slice(lastAnswer + 1));
  const known = lines.at(-1);
  if (last.includes('task-notification') && !last.includes('tool_result') && known !== undefined) return { worker, blocks: send(known, `a worker reported, relayed on ${model}`) };
  if (last.includes('tool_result') || last.includes('task-notification')) return { worker, blocks: [{ type: 'text', text: 'done' }] };
  const line = [...last.matchAll(LINE_RE)].at(-1)?.[1];
  if (line !== undefined) lines.push(line);
  if (last.includes('DELEGATE'))
    return { worker, blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'check', prompt: `${WORKER_TASK}: reply done`, subagent_type: 'general-purpose', run_in_background: true } }] };
  if (line !== undefined) return { worker, blocks: send(line, `answered on ${model}`) };
  return { worker, blocks: [{ type: 'text', text: 'ok' }] };
}

function stream(res: ServerResponse, model: string, blocks: Block[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const write = (event: string, data: Record<string, unknown>): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  };
  const usage = { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  write('message_start', { message: { id: `msg_${String(Date.now())}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      write('content_block_start', { index, content_block: { type: 'text', text: '' } });
      write('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      write('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${String(Date.now())}${String(index)}`, name: block.name, input: {} } });
      write('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    write('content_block_stop', { index });
  });
  const tool = blocks.some((block) => block.type === 'tool_use');
  write('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
  write('message_stop', {});
  res.end();
}

function parse(raw: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function serve(req: IncomingMessage, res: ServerResponse, raw: Buffer, seen: UpstreamRequest[], t0: number, lines: string[]): void {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [], has_more: false }));
    return;
  }
  if (path.endsWith('/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  const body = parse(raw);
  const model = typeof body.model === 'string' ? body.model : '?';
  const { worker, blocks } = answerFor(body, model, lines);
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ id: 'msg_quiet', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }),
    );
    return;
  }
  seen.push({ t: Date.now() - t0, model, worker });
  stream(res, model, blocks);
}

export function startScripted(port: number): Promise<ScriptedUpstream> {
  const seen: UpstreamRequest[] = [];
  const lines: string[] = [];
  const t0 = Date.now();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      serve(req, res, Buffer.concat(chunks), seen, t0, lines);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ seen, close: () => server.close() });
    });
  });
}
