import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { encodeSignature } from '../src/gateway/codex-translate.ts';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '../src/gateway/gateway.ts';
import type { ModelSetup } from '../src/gateway/model-config.ts';
import { codexAccess, connectionId, makeConnection } from './model-fixture.ts';

interface Sent {
  body: { instructions: string; tools: unknown[]; tool_choice: unknown; reasoning: unknown; input: unknown[]; prompt_cache_key: string };
}

const SESSION = '00aa40fe-af70-4e44-9868-2f81a5c380f6';
const sent: Sent[] = [];
const servers: Server[] = [];
let base = '';

const completed = [
  { type: 'response.created', response: { id: 'r' } },
  { type: 'response.output_item.done', item: { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 9, output_tokens: 1 } } },
];

async function listen(server: Server): Promise<string> {
  const port = randomInt(10_000, 30_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${String(port)}`;
}

const setup: ModelSetup = {
  primary: { connection: connectionId('codex'), model: 'gpt-6.1-sol' },
  fallbacks: [],
  connections: [makeConnection('codex', { codex: codexAccess() })],
  source: 'organization',
};

const reminder = (text: string, last: boolean): Record<string, unknown> => ({ role: 'system', content: last ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text });

const step = (n: number): Record<string, unknown>[] => [
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: encodeSignature({ id: `rs_${String(n)}`, encrypted_content: `ENC${String(n)}` }) },
      { type: 'tool_use', id: `call_${String(n)}`, name: 'Bash', input: { command: `echo step ${String(n)}`, description: 'Say a step' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${String(n)}`, content: `step ${String(n)}` }] },
];

function helperTurn(steps: number, task = 'Check that the build passes.'): Record<string, unknown> {
  const work = Array.from({ length: steps }, (_, n) => [...step(n + 1), reminder('<total_tokens>14998990 tokens left</total_tokens>', n + 1 === steps)]).flat();
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nAttribution rules.\n</system-reminder>' }, { type: 'text', text: task }] },
    reminder('The following deferred tools are now available via ToolSearch: NotebookEdit', steps === 0),
    ...work,
  ];
  return {
    model: 'codex:gpt-6.1-sol',
    max_tokens: 32000,
    stream: true,
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: 'high' },
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.287.ed6; cc_entrypoint=sdk-ts; cc_is_subagent=true;' }, { type: 'text', text: 'You are an agent for Claude Code.' }],
    tools: [{ name: 'Bash', description: 'Run a command.', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    messages,
  };
}

async function ask(body: Record<string, unknown>, headers: Record<string, string>): Promise<Sent> {
  const res = await fetch(`${base}/gateway/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', ...headers }, body: JSON.stringify(body) });
  await res.text();
  const last = sent.at(-1);
  if (last === undefined) throw new Error('nothing reached Codex');
  return last;
}

const helper = (agent: string): Record<string, string> => ({ 'x-claude-code-session-id': SESSION, 'x-claude-code-agent-id': agent });

beforeAll(async () => {
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      sent.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Sent['body'] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of completed) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  const at = await listen(upstream);
  const deps: GatewayDeps = { setup: () => setup, identify: (key) => key === 'mk_ok', codex: { base: at, refresh: () => Promise.resolve(null) } };
  base = await listen(
    createServer((req, res) => {
      if (!handleGatewayRequest(req, res, deps)) res.writeHead(404).end();
    }),
  );
});

afterAll(() => {
  for (const server of servers) server.close();
});

beforeEach(() => {
  resetGatewayState();
  sent.length = 0;
});

describe('consecutive turns of one Codex conversation', () => {
  test('each request starts with the whole previous one, so the prompt cache can hold all of it', async () => {
    const turns = [];
    for (const steps of [0, 1, 2, 3]) turns.push(await ask(helperTurn(steps), helper('ad1463f86bc56c911')));
    for (const [at, later] of turns.entries()) {
      const earlier = turns[at - 1];
      if (earlier === undefined) continue;
      expect(later.body.instructions).toBe(earlier.body.instructions);
      expect(later.body.tools).toEqual(earlier.body.tools);
      expect(later.body.tool_choice).toEqual(earlier.body.tool_choice);
      expect(later.body.reasoning).toEqual(earlier.body.reasoning);
      expect(later.body.prompt_cache_key).toBe(earlier.body.prompt_cache_key);
      expect(later.body.input.length).toBeGreaterThan(earlier.body.input.length);
      expect(later.body.input.slice(0, earlier.body.input.length)).toEqual(earlier.body.input);
    }
  });

  test('every thread has its own cache key: the main thread keeps the session id, and each helper gets one of its own', async () => {
    const main = await ask({ ...helperTurn(1), system: [{ type: 'text', text: 'You are Claude Code.' }] }, { 'x-claude-code-session-id': SESSION });
    const first = await ask(helperTurn(1), helper('ad1463f86bc56c911'));
    const again = await ask(helperTurn(2), helper('ad1463f86bc56c911'));
    const other = await ask(helperTurn(1, 'Read the logs.'), helper('a77f02c1d94b3e605'));
    expect(main.body.prompt_cache_key).toBe(SESSION);
    expect(first.body.prompt_cache_key).not.toBe(SESSION);
    expect(again.body.prompt_cache_key).toBe(first.body.prompt_cache_key);
    expect(other.body.prompt_cache_key).not.toBe(first.body.prompt_cache_key);
  });
});
