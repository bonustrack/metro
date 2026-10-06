import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

interface Message {
  role: string;
  content: string | { type: string; text?: string; tool_use_id?: string }[];
}

interface Request {
  model: string;
  stream?: boolean;
  messages?: Message[];
}

function stream(res: ServerResponse, model: string, text: string, send: boolean, delegate = false): void {
  if (res.destroyed) return;
  const action = delegate ? { name: 'Agent', input: { description: 'Recovery fixture worker', prompt: text === 'RECOVERY_FAILED_WORKER' ? 'RECOVERY_HOLD_REFUSAL' : 'RECOVERY_HOLD_CHILD', subagent_type: 'worker', run_in_background: true } } : { name: 'mcp__metro__fixture_write', input: { text } };
  const tool = send || delegate;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event: string, data: object): void => { res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); };
  emit('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
  emit('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: `toolu_${text}`, name: action.name, input: {} } : { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(action.input) } : { type: 'text_delta', text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
  emit('message_stop', {});
  res.end();
}

function refusal(res: ServerResponse): void {
  res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Fixture worker terminal refusal' } }));
}

export async function recoveryUpstream(): Promise<{ base: string; held: Set<string>; seen: string[]; launched: string[]; refuse(name: string): void; close(): void }> {
  const held = new Set<string>();
  const requests = new Map<string, ServerResponse>();
  const refused = new Set<string>();
  const seen: string[] = [];
  const launched: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Request;
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 50 }));
        return;
      }
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_helper', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }));
        return;
      }
      const messages = body.messages ?? [];
      const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
      const fresh = messages.slice(lastAssistant + 1);
      const blocks = fresh.flatMap((message) => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content);
      const after = blocks.find((block) => block.type === 'tool_result')?.tool_use_id;
      const text = blocks.map((block) => block.text ?? '').join('\n');
      const marker = /RECOVERY_[A-Z_]+/.exec(text)?.[0];
      if (marker !== undefined) seen.push(marker);
      if (marker?.startsWith('RECOVERY_HOLD_') === true || after?.startsWith('toolu_RECOVERY_SIDE_') === true) {
        const name = marker ?? after ?? '';
        held.add(name);
        if (refused.has(name)) { refusal(res); return; }
        requests.set(name, res);
        return;
      }
      const acknowledgments = text.match(/\[metro-task-handled:[A-Za-z0-9-]+\]/g);
      const request = acknowledgments === null && after === undefined && marker !== undefined && text.includes('<channel ');
      const delegate = request && (marker === 'RECOVERY_WORKER' || marker === 'RECOVERY_FAILED_WORKER');
      if (delegate && marker !== undefined) launched.push(marker);
      stream(res, body.model, acknowledgments?.join('\n') ?? marker ?? 'done', request, delegate);
    });
  });
  const port = 20_000 + Math.floor(Math.random() * 9_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${String(port)}`,
    held,
    seen,
    launched,
    refuse: (name) => {
      const res = requests.get(name);
      if (res === undefined || res.destroyed) throw new Error('Fixture refusal has no live request');
      refused.add(name);
      refusal(res);
      requests.delete(name);
    },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}
