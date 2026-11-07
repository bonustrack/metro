import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap, setApproversMap } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { expirePrompts, forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { setPolicies } from '../src/policy/policy.ts';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';
import { initSession, openGet, type GetStream } from './mcp-probe.ts';
import { waitFor } from './wait.ts';

const AGENT = 'agent000001';
const TOKEN = 'mk_channel_asks';
const TG = 'tb000000001';
const LINE = `metro://telegram-bot/${TG}/-100777`;
const OWNER = `metro://telegram-bot/${TG}/user/111`;
const TARGET = { kind: 'channel', station: 'telegram-bot', account: TG } as const;

interface TrainCall {
  action: string;
  args: Record<string, unknown>;
}

interface ToolAnswer {
  text: string;
  isError: boolean;
}

let calls: TrainCall[] = [];
let mcpServer: Server | undefined;
let mcpUrl = '';
let page: Daemon | undefined;
let stream: GetStream | undefined;
let sessionId = '';

const headers = (): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-session-id': sessionId,
  'mcp-protocol-version': '2025-06-18',
});

const chat = (text: string): void => {
  publishEvent({
    id: `ev-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'telegram-bot',
    line: asLine(LINE),
    from: asLine(OWNER),
    to: asLine(LINE),
    text,
    messageId: `mm-${randomUUID()}`,
    event: { type: 'msg' },
  } as unknown as MetroEvent);
};

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(mcpUrl, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  const raw = await res.text();
  const json = raw.trimStart().startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data: ')) ?? '').slice(6);
  return (JSON.parse(json) as { result: Record<string, unknown> }).result;
}

async function send(args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await rpc('tools/call', { name: 'send', arguments: args });
  const content = result.content as { text: string }[];
  return { text: content.map((c) => c.text).join('\n'), isError: result.isError === true };
}

const idIn = (answer: ToolAnswer): string => {
  const id = /approval id "([a-km-z]{5})"/.exec(answer.text)?.[1];
  if (id === undefined) throw new Error(`no approval id in: ${answer.text}`);
  return id;
};

const sends = (): TrainCall[] => calls.filter((c) => c.action === 'send');

async function pageCall(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (page === undefined) throw new Error('no page daemon');
  const res = await fetch(`${page.base}/api/approvals${path}`, {
    method,
    headers: { authorization: await auth(TEST_OWNER, 'member'), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  forgetAllPrompts();
  setKeyMap([{ key: TOKEN, agentId: AGENT }]);
  setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
  setAllowlistMap({ [`telegram-bot/${TG}`]: ['111'] });
  setApproversMap({ [`telegram-bot/${TG}`]: ['111'] });
  const handler = await createMetroMcp({ publish: publishEvent });
  handler.startInbound();
  mcpServer = createServer((req, res) => {
    handler.httpHandler(req, res).catch(() => undefined);
  });
  await new Promise<void>((r) => mcpServer?.listen(0, '127.0.0.1', () => r()));
  mcpUrl = `http://127.0.0.1:${String((mcpServer.address() as AddressInfo).port)}/mcp?token=${TOKEN}`;
  sessionId = await initSession(mcpUrl);
  stream = await openGet(mcpUrl, sessionId);
  page = await bootDaemon({});
  chat('hello agent');
  await waitFor(() => (stream?.raw() ?? '').includes('hello agent'));
});

afterAll(async () => {
  await stream?.stop();
  await page?.close();
  if (mcpServer) await new Promise<void>((r) => mcpServer?.close(() => r()));
  setKeyMap([]);
  setAgentMap({}, {});
  setAllowlistMap({});
  setApproversMap({});
  setPolicies('channel', []);
  forgetAllPrompts();
});

beforeEach(() => {
  calls = [];
  forgetAllPrompts();
  setPolicies('channel', [[TARGET, { write: 'ask' }]]);
  setTrainCallBackend((_train, action, args) => {
    calls.push({ action, args: args as Record<string, unknown> });
    return Promise.resolve({ result: { messageId: `m-${String(calls.length)}` } });
  });
});

describe('a channel call that needs approval, held by the daemon', () => {
  test('answers at once with an id, asks the owner in chat once, and runs once after a yes there', async () => {
    const first = await send({ line: LINE, text: 'hi' });
    expect(first.isError).toBe(true);
    expect(first.text).toStartWith("Needs the owner's approval for telegram-bot (send). The owner was asked in chat");
    const id = idIn(first);
    await waitFor(() => sends().length === 1);
    expect(sends()[0]?.args).toEqual({ line: LINE, text: `Approval needed: send\nChannel: telegram-bot · -100777\nText: "hi"\n\nReply "yes ${id}" or "no ${id}"` });
    expect(idIn(await send({ line: LINE, text: 'hi' }))).toBe(id);
    expect(sends()).toHaveLength(1);

    chat(`yes ${id}`);
    await waitFor(() => (stream?.raw() ?? '').includes(`Approved: send on telegram-bot (${id})`));
    expect(pendingPrompts()).toEqual([]);

    const ran = await send({ line: LINE, text: 'hi', approval: id });
    expect(ran.isError).toBe(false);
    expect(sends()[1]?.args).toEqual({ line: LINE, text: 'hi' });
    expect((await send({ line: LINE, text: 'hi', approval: id })).text).toStartWith("Needs the owner's approval");
  });

  test('a denial on the page tells the chat and the agent, and the id stays denied', async () => {
    const id = idIn(await send({ line: LINE, text: 'second' }));
    expect((await pageCall('POST', `/${id}`, { decision: 'deny' })).status).toBe(200);
    await waitFor(() => (stream?.raw() ?? '').includes(`Denied: send on telegram-bot (${id}).`));
    await waitFor(() => sends().some((c) => c.args.text === 'Denied on the page.'));
    expect((await send({ line: LINE, text: 'second', approval: id })).text).toStartWith('Denied by the owner for telegram-bot (send)');
    expect(sends().some((c) => c.args.text === 'second')).toBe(false);
  });

  test('the page lists it with the tool name and a JSON preview whose long strings are shortened', async () => {
    const long = 'x'.repeat(2000);
    const id = idIn(await send({ line: LINE, text: long }));
    const listed = (await pageCall('GET', '')).body.approvals as { id: string; tool: string; preview: string; line: string | null }[];
    const shown = listed.find((a) => a.id === id);
    expect(shown).toMatchObject({ tool: 'mcp__metro__send', line: LINE });
    expect(shown?.preview).toContain('⋯ 1500 code points elided ⋯');
    expect(() => JSON.parse(shown?.preview ?? '') as unknown).not.toThrow();
    expect(await expirePrompts(Date.now() + 25 * 3_600_000)).toBe(1);
    await waitFor(() => (stream?.raw() ?? '').includes(`Denied: send on telegram-bot (${id}).`));
  });

  test('every gated metro tool takes an approval id; the ungated ones do not', async () => {
    const { tools } = (await rpc('tools/list', {})) as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] };
    const props = (name: string): Record<string, unknown> => tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
    for (const name of ['send', 'reply', 'react', 'read', 'create_group']) expect(props(name).approval).toMatchObject({ pattern: '^[a-km-z]{5}$' });
    for (const name of ['list_accounts', 'create_upload', 'tool_search', 'tool_call']) expect(props(name).approval).toBeUndefined();
  });
});
