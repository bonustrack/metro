import { answerPrompt, holdPrompt } from '../src/approvals/pending.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleRelayRequest, type RelayApiDeps } from '../src/connectors/relay.ts';
import { blockedReason, registerConnectors } from '../src/connectors/gates.ts';

const CONN = 'conn0000001';
const KEY = 'key-agent000001';

let seen: unknown[] = [];
let sse = false;
let upstream: Server;
let relay: Server;
let upBase = '';
let base = '';

const deps: RelayApiDeps = {
  signedOut: () => undefined,
  target: () => Promise.resolve({ kind: 'ok', url: `${upBase}/mcp`, headers: {} }),
  identify: (req) => (req.headers.authorization === `Bearer ${KEY}` ? { subject: 'agent-key', agentId: 'agent000001' } : null),
  blocked: blockedReason,
};

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const resultFor = (message: unknown): unknown =>
  typeof message === 'object' && message !== null && 'id' in message ? { jsonrpc: '2.0', id: message.id, result: { upstream: true } } : null;

function vendor(req: IncomingMessage, res: ServerResponse): void {
  bodyOf(req)
    .then((text) => {
      const parsed: unknown = JSON.parse(text);
      seen.push(parsed);
      const answers = (Array.isArray(parsed) ? parsed : [parsed]).map(resultFor).filter((a) => a !== null);
      if (answers.length === 0) {
        res.writeHead(202).end();
        return;
      }
      const body = Array.isArray(parsed) ? answers : answers[0];
      if (sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' });
        res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
      res.end(JSON.stringify(body));
    })
    .catch(() => {
      res.writeHead(500).end();
    });
}

const call = (id: number, name: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

async function post(body: unknown): Promise<{ status: number; text: string; session: string | null }> {
  const res = await fetch(`${base}/relay/${CONN}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), session: res.headers.get('mcp-session-id') };
}

const blockedText = (tool: string): string => `Blocked by the owner's policy for Linear (${tool}).`;

beforeAll(async () => {
  upstream = createServer(vendor);
  relay = createServer((req, res) => {
    handleRelayRequest(req, res, deps);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));
  upBase = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  base = `http://127.0.0.1:${String((relay.address() as AddressInfo).port)}`;
  registerConnectors([
    { id: CONN, name: 'Linear', config: { policy: { write: 'deny', tools: { get_issue: 'ask' } }, toolGroups: { list_issues: 'read', get_issue: 'read', delete_issue: 'write' } } },
  ]);
});

afterAll(() => {
  registerConnectors([]);
  upstream.close();
  relay.close();
});

beforeEach(() => {
  seen = [];
  sse = false;
});

describe('the relay applies the owner policy to tools/call', () => {
  test('a blocked call is answered by metro as a tool error and never reaches the connector', async () => {
    const out = await post(call(7, 'delete_issue'));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.text)).toEqual({ jsonrpc: '2.0', id: 7, result: { isError: true, content: [{ type: 'text', text: blockedText('delete_issue') }] } });
    expect(seen).toEqual([]);
  });

  test('a tool metro never saw listed counts as write and is blocked too', async () => {
    const out = await post(call(8, 'brand_new'));
    expect(JSON.parse(out.text)).toMatchObject({ id: 8, result: { isError: true } });
    expect(seen).toEqual([]);
  });

  test('an allowed call passes byte for byte, an ask call only once the owner approved it', async () => {
    const waiting = await post(call(9, 'get_issue'));
    expect(JSON.parse(waiting.text)).toMatchObject({ id: 9, result: { isError: true, content: [{ text: expect.stringContaining("Needs the owner's approval for Linear (get_issue)") as unknown as string }] } });
    expect(seen).toEqual([]);
    holdPrompt({ requestId: 'rlyaa', tool: 'mcp__plugin_metro_linear__get_issue', description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
    await answerPrompt('rlyaa', 'allow', 'chat');
    for (const name of ['list_issues', 'get_issue']) {
      const out = await post(call(9, name));
      expect(JSON.parse(out.text)).toEqual({ jsonrpc: '2.0', id: 9, result: { upstream: true } });
      expect(out.session).toBe('s1');
    }
    expect(seen).toEqual([call(9, 'list_issues'), call(9, 'get_issue')]);
  });

  test('anything but tools/call is untouched', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const out = await post(list);
    expect(JSON.parse(out.text)).toMatchObject({ id: 1, result: { upstream: true } });
    expect(seen).toEqual([list]);
  });

  test('a mixed batch forwards the rest and merges metro\'s answers into the reply', async () => {
    const out = await post([call(1, 'list_issues'), call(2, 'delete_issue'), { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }]);
    expect(seen).toEqual([[call(1, 'list_issues'), { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }]]);
    const reply = JSON.parse(out.text) as { id: number; result: Record<string, unknown> }[];
    expect(reply.map((r) => [r.id, r.result.isError === true])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  test('a mixed batch over SSE gets metro\'s answers as extra frames', async () => {
    sse = true;
    const out = await post([call(1, 'list_issues'), call(2, 'delete_issue')]);
    expect(out.text).toContain('"upstream":true');
    expect(out.text).toContain(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: blockedText('delete_issue') }] } })}`);
  });

  test('a batch of blocked calls only never reaches the connector', async () => {
    const out = await post([call(3, 'delete_issue'), call(4, 'create_issue')]);
    expect(seen).toEqual([]);
    expect((JSON.parse(out.text) as { id: number }[]).map((r) => r.id)).toEqual([3, 4]);
  });
});
