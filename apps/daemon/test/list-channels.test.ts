import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ChannelList } from '@metro-labs/core/stations/channel-directory';
import { setAgentMap, setDisabledAccounts, lineReceives } from '../src/agents/map.ts';
import { answerPrompt, forgetAllPrompts, holdPrompt, pendingPrompts } from '../src/approvals/pending.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { registerToolHandlers } from '../src/mcp/tool-dispatch.ts';
import { channelToolsOf } from '../src/mcp/tool-catalog.ts';
import { setPolicies, type ToolPolicy } from '../src/policy/policy.ts';
import { stationByName } from '../src/stations/registry.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';

const AGENT = 'agentA00001';
const OTHER = 'agentB00001';
const ACCOUNT = 'tg000000001';
const FOREIGN = 'tg000000002';
const XMTP = 'xm000000001';
const TARGET = { kind: 'channel', station: 'telegram', account: ACCOUNT } as const;
const CHANNEL = { id: '-100123', line: `metro://telegram/${ACCOUNT}/-100123`, name: 'Research', kind: 'group' } as const;

let server: Server;
let client: Client;
let calls: { train: string; action: string; args: unknown }[];
let answer: ChannelList;

beforeEach(async () => {
  calls = [];
  answer = { channels: [CHANNEL], capability: { supported: true, complete: true, source: 'remote' } };
  setAgentMap({
    [`telegram/${ACCOUNT}`]: AGENT,
    [`telegram/${FOREIGN}`]: OTHER,
    [`xmtp/${XMTP}`]: AGENT,
    'webhook/hook0000001': AGENT,
  }, { [AGENT]: 'Ada', [OTHER]: 'Bea' });
  setDisabledAccounts(new Set());
  setPolicies('channel', []);
  forgetAllPrompts();
  setTrainCallBackend((train, action, args) => {
    calls.push({ train, action, args });
    return Promise.resolve({ result: answer });
  });
  server = new Server({ name: 'metro-test', version: '0' }, { capabilities: { tools: {} } });
  client = new Client({ name: 'channel-discovery-test', version: '0' });
  registerToolHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  setPolicies('channel', []);
  setAgentMap({}, {});
  setDisabledAccounts(new Set());
  forgetAllPrompts();
  setTrainCallBackend(() => Promise.reject(new Error('test backend closed')));
});

const call = (args: Record<string, unknown>): Promise<CallToolResult> =>
  runWithIdentity({ kind: 'agent', agentId: AGENT }, () =>
    client.request({ method: 'tools/call', params: { name: 'list_channels', arguments: args } }, CallToolResultSchema));

const text = (result: CallToolResult): string => result.content.flatMap((c) => c.type === 'text' ? [c.text] : []).join('\n');

async function approve(id: string, args: Record<string, unknown>, tool = 'list_channels', decision: 'allow' | 'deny' = 'allow'): Promise<void> {
  holdPrompt({ requestId: id, tool: `mcp__metro__${tool}`, description: '', preview: JSON.stringify(args), line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt(id, decision, 'page');
}

describe('registered list_channels', () => {
  test('publishes an account-required read tool with bounded discovery inputs', async () => {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'list_channels')).toMatchObject({
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        required: ['account'],
        properties: {
          account: { type: 'string', minLength: 1 },
          query: { type: 'string', maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          cursor: { type: 'string', minLength: 1, maxLength: 2048 },
        },
      },
    });
    const station = stationByName('telegram');
    if (station === undefined) throw new Error('missing telegram');
    expect(channelToolsOf(station)).toContainEqual({ name: 'list_channels', group: 'read' });
  });

  test('discovers with no inbound message and forwards only bounded directory arguments', async () => {
    const result = await call({ account: ACCOUNT, query: 'ReSeArCh', limit: 3, cursor: 'opaque-page', line: `metro://xmtp/${XMTP}/wrong`, station: 'xmtp' });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([{ train: 'telegram', action: 'listChannels', args: { account: ACCOUNT, query: 'ReSeArCh', limit: 3, cursor: 'opaque-page' } }]);
    expect(JSON.parse(text(result))).toEqual({ ...answer, account: ACCOUNT, station: 'telegram' });
  });

  test('Receive Off leaves discovery available and supplies the default limit', async () => {
    setDisabledAccounts(new Set([`telegram/${ACCOUNT}`]));
    expect(lineReceives(CHANNEL.line)).toBe(false);
    expect((await call({ account: ACCOUNT })).isError).not.toBe(true);
    expect(calls).toEqual([{ train: 'telegram', action: 'listChannels', args: { account: ACCOUNT, limit: 50 } }]);
  });

  test('preserves partial capability, opaque continuation and source without inventing completion', async () => {
    answer = { channels: [CHANNEL], capability: { supported: true, complete: false, source: 'local', reason: 'Only locally known conversations.' }, next_cursor: 'next-page' };
    expect(JSON.parse(text(await call({ account: ACCOUNT })))).toEqual({ ...answer, account: ACCOUNT, station: 'telegram' });
  });

  test('a station without a train returns honest unsupported metadata', async () => {
    const result = await call({ account: 'hook0000001' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ account: 'hook0000001', station: 'webhook', channels: [], capability: { supported: false, complete: false, source: 'unsupported', reason: expect.any(String) } });
    expect(calls).toEqual([]);
  });

  test('a station with discovery disabled never invokes its train', async () => {
    const station = stationByName('telegram');
    if (station === undefined) throw new Error('missing telegram');
    const previous = station.discoversChannels;
    station.discoversChannels = false;
    try {
      const result = await call({ account: ACCOUNT });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(text(result))).toMatchObject({ channels: [], capability: { supported: false, complete: false, source: 'unsupported', reason: expect.any(String) } });
      expect(channelToolsOf(station).some((tool) => tool.name === 'list_channels')).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete station.discoversChannels;
      else station.discoversChannels = previous;
    }
  });

  test('does not disguise a train failure as an empty directory', async () => {
    setTrainCallBackend(() => Promise.resolve({ error: 'directory unavailable' }));
    const result = await call({ account: ACCOUNT });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('directory unavailable');
  });
});

describe('account-only discovery scope', () => {
  for (const account of [FOREIGN, 'unknown-account'])
    test(`${account} is rejected even with an allowed surplus line`, async () => {
      const result = await call({ account, line: CHANNEL.line, station: 'telegram' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('outside your authorized scope');
      expect(calls).toEqual([]);
    });

  test('no identity cannot reach an otherwise valid account', async () => {
    const result = await client.request({ method: 'tools/call', params: { name: 'list_channels', arguments: { account: ACCOUNT } } }, CallToolResultSchema);
    expect(text(result)).toContain('outside your authorized scope');
    expect(calls).toEqual([]);
  });

  for (const [station, owner] of [['xmtp', OTHER], ['xmtp', AGENT], ['webhook', OTHER]] as const)
    test(`ambiguity with ${station}/${owner} is rejected across all stations, not just in-scope discovery providers`, async () => {
      setAgentMap({ [`telegram/${ACCOUNT}`]: AGENT, [`${station}/${ACCOUNT}`]: owner }, { [AGENT]: 'Ada', [OTHER]: 'Bea' });
      const result = await call({ account: ACCOUNT, line: CHANNEL.line, station: 'telegram' });
      expect(text(result)).toContain('outside your authorized scope');
      expect(calls).toEqual([]);
    });

  test('an account attached to an unknown station is rejected before policy or train', async () => {
    setAgentMap({ [`not-a-station/${ACCOUNT}`]: AGENT }, { [AGENT]: 'Ada' });
    setPolicies('channel', [[{ ...TARGET, station: 'not-a-station' }, { read: 'deny' }]]);
    expect(text(await call({ account: ACCOUNT }))).toContain('outside your authorized scope');
    expect(calls).toEqual([]);
  });

  test('scope denial does not settle prompts or consume a grant', async () => {
    const args = { account: FOREIGN };
    setPolicies('channel', [[{ ...TARGET, account: FOREIGN }, { read: 'ask' }]]);
    await approve('aaaaa', args);
    holdPrompt({ requestId: 'bbbbb', tool: 'mcp__metro__list_channels', description: '', preview: JSON.stringify(args), line: undefined, at: Date.now() }, {}, () => Promise.resolve());
    expect(text(await call(args))).toContain('outside your authorized scope');
    expect(pendingPrompts()).toHaveLength(1);
    expect(calls).toEqual([]);
    setAgentMap({ [`telegram/${FOREIGN}`]: AGENT }, { [AGENT]: 'Ada' });
    expect((await call(args)).isError).not.toBe(true);
    expect(pendingPrompts()).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});

describe('discovery read policies and grants', () => {
  const policies: [ToolPolicy, string][] = [
    [{ read: 'deny' }, "Blocked by the owner's policy"],
    [{ read: 'ask' }, "Needs the owner's approval"],
    [{ read: 'allow', tools: { list_channels: 'deny' } }, "Blocked by the owner's policy"],
    [{ read: 'allow', tools: { list_channels: 'ask' } }, "Needs the owner's approval"],
  ];
  for (const [policy, prefix] of policies)
    test(`account policy ${JSON.stringify(policy)} cannot be redirected by a surplus line or station`, async () => {
      setDisabledAccounts(new Set([`telegram/${ACCOUNT}`]));
      setPolicies('channel', [[TARGET, policy]]);
      const result = await call({ account: ACCOUNT, line: `metro://xmtp/${XMTP}/allowed`, station: 'xmtp' });
      expect(text(result)).toStartWith(`${prefix} for telegram (list_channels)`);
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    });

  test('a surplus denied and out-of-scope line cannot redirect an allowed account', async () => {
    setPolicies('channel', [[{ ...TARGET, account: FOREIGN }, { read: 'deny' }], [TARGET, { write: 'deny' }]]);
    const result = await call({ account: ACCOUNT, line: `metro://telegram/${FOREIGN}/other`, station: 'xmtp' });
    expect(result.isError).not.toBe(true);
    expect(calls[0]?.args).toEqual({ account: ACCOUNT, limit: 50 });
  });

  test('per-tool allow overrides read denial', async () => {
    setPolicies('channel', [[TARGET, { read: 'deny', tools: { list_channels: 'allow' } }]]);
    expect((await call({ account: ACCOUNT })).isError).not.toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('only the exact raw arguments and tool consume one grant; a denied prompt grants nothing', async () => {
    const args = { account: ACCOUNT, query: 'ReSeArCh ', limit: 2 };
    setPolicies('channel', [[TARGET, { read: 'ask' }]]);
    expect((await call(args)).isError).toBe(true);
    await approve('aaaaa', { ...args, query: 'research' });
    await approve('bbbbb', args, 'read');
    await approve('ccccc', { ...args, account: XMTP });
    expect((await call(args)).isError).toBe(true);
    expect(calls).toEqual([]);
    await approve('ddddd', args);
    expect((await call(args)).isError).not.toBe(true);
    expect(calls).toEqual([{ train: 'telegram', action: 'listChannels', args }]);
    expect((await call(args)).isError).toBe(true);
    await approve('eeeee', args, 'list_channels', 'deny');
    expect((await call(args)).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('even unsupported discovery is gated by the account read policy', async () => {
    setPolicies('channel', [[{ kind: 'channel', station: 'webhook', account: 'hook0000001' }, { read: 'deny' }]]);
    expect(text(await call({ account: 'hook0000001' }))).toStartWith("Blocked by the owner's policy");
    expect(calls).toEqual([]);
  });
});

describe('discovery input validation at registered dispatch', () => {
  const invalid: Record<string, unknown>[] = [
    {}, { line: CHANNEL.line }, { station: 'telegram' }, { account: '' }, { account: '   ' }, { account: null }, { account: 42 },
    ...[null, 42, 'x'.repeat(201)].map((query) => ({ account: ACCOUNT, query })),
    ...[null, '50', 0, -1, 101, 1.5].map((limit) => ({ account: ACCOUNT, limit })),
    ...[null, 42, '', 'x'.repeat(2049)].map((cursor) => ({ account: ACCOUNT, cursor })),
  ];
  for (const [index, args] of invalid.entries())
    test(`refuses invalid input ${index + 1} before any policy prompt or train call`, async () => {
      setPolicies('channel', [[TARGET, { read: 'ask' }]]);
      const result = await call(args);
      expect(result.isError).toBe(true);
      expect(text(result)).not.toStartWith("Needs the owner's approval");
      expect(calls).toEqual([]);
      expect(pendingPrompts()).toHaveLength(0);
    });

  test('accepts the exact query, cursor and limit bounds', async () => {
    const args = { account: ACCOUNT, query: 'x'.repeat(200), cursor: 'y'.repeat(2048), limit: 100 };
    expect((await call(args)).isError).not.toBe(true);
    expect(calls[0]?.args).toEqual(args);
    expect((await call({ account: ACCOUNT, query: '', limit: 1 })).isError).not.toBe(true);
  });
});
