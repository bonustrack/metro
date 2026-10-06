import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAgentMap } from '../src/agents/map.ts';
import { setPolicies } from '../src/policy/policy.ts';
import { channelDecision } from '../src/mcp/policy-gate.ts';
import { policySnapshotPath, watchPolicySnapshot } from '../src/mcp/policy-snapshot.ts';

const GUARD = join(import.meta.dir, '..', '..', '..', 'plugin', 'bin', 'guard.mjs');
const AGENT = 'agent000001';
const TG = 'tg000000001';
const XM = 'xm000000001';
const WA = 'wa000000001';
const WA_OTHER = 'wa000000002';
const LINE = `metro://telegram/${TG}/-100555`;

let dir = '';
let stop: (() => void) | undefined;

const read = (): Record<string, unknown> => JSON.parse(readFileSync(policySnapshotPath(dir), 'utf8')) as Record<string, unknown>;

function hook(tool: string, input: Record<string, unknown>): string {
  const run = spawnSync('node', [GUARD], {
    input: JSON.stringify({ tool_name: `mcp__metro__${tool}`, tool_input: input, agent_id: 'w1' }),
    encoding: 'utf8',
    env: { ...process.env, METRO_AGENTS_DIR: dir },
  });
  if (run.stdout.trim() === '') return 'allow';
  return (JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-policy-snapshot-'));
  process.env.METRO_AGENTS_DIR = dir;
  setAgentMap({
    [`telegram/${TG}`]: AGENT,
    [`xmtp/${XM}`]: AGENT,
    [`whatsapp/${WA}`]: AGENT,
    [`whatsapp/${WA_OTHER}`]: AGENT,
  }, { [AGENT]: 'Andy' });
  stop = watchPolicySnapshot();
});

afterAll(() => {
  stop?.();
  setPolicies('channel', []);
  setAgentMap({}, {});
  delete process.env.METRO_AGENTS_DIR;
});

describe('the policy snapshot the plugin hook reads', () => {
  test('is written at start and again whenever a policy changes, owner-only', () => {
    expect(read()).toMatchObject({ version: 1, accounts: {}, stations: { telegram: [TG], xmtp: [XM] } });
    expect(statSync(policySnapshotPath(dir)).mode & 0o777).toBe(0o600);
    setPolicies('channel', [[{ kind: 'channel', station: 'telegram', account: TG }, { write: 'ask', tools: { delete: 'deny' } }]]);
    const snap = read();
    expect(snap.accounts).toEqual({ [`telegram/${TG}`]: { write: 'ask', tools: { delete: 'deny' } } });
    expect((snap.tools as Record<string, string>).send).toBe('write');
    expect((snap.tools as Record<string, string>).read).toBe('read');
    expect((snap.tools as Record<string, string>).list_channels).toBe('read');
    expect((snap.owners as Record<string, string>).group_info).toBe('xmtp');
    expect(snap.ungated).toEqual(['list_accounts', 'create_upload']);
  });

  test('the hook and the daemon reach the same verdict from it', () => {
    setPolicies('channel', [
      [{ kind: 'channel', station: 'telegram', account: TG }, { write: 'ask', tools: { delete: 'deny' } }],
      [{ kind: 'channel', station: 'xmtp', account: XM }, { read: 'deny' }],
    ]);
    const calls: [string, Record<string, unknown>][] = [
      ['send', { line: LINE, text: 'hi' }],
      ['delete', { line: LINE, message_id: 'm1' }],
      ['read', { line: LINE }],
      ['react', { account: TG, line: LINE, emoji: '👍' }],
      ['group_info', {}],
      ['create_group', { station: 'telegram', name: 'crew' }],
      ['get_profile', { from: `metro://xmtp/${XM}/user/abc` }],
      ['list_accounts', {}],
    ];
    for (const [tool, input] of calls) expect(`${tool}: ${hook(tool, input)}`).toBe(`${tool}: ${channelDecision(tool, input).access}`);
  });

  for (const access of ['deny', 'ask'] as const)
    test(`discovery uses only the required account policy (${access}) in the hook and daemon`, () => {
      setPolicies('channel', [[{ kind: 'channel', station: 'telegram', account: TG }, { read: access }]]);
      const calls: [Record<string, unknown>, string][] = [
        [{ account: TG }, access],
        [{ account: TG, line: `metro://xmtp/${XM}/wrong`, station: 'xmtp' }, access],
        [{ account: XM, line: LINE, station: 'telegram' }, 'allow'],
        [{ line: LINE, station: 'telegram' }, 'allow'],
      ];
      for (const [input, expected] of calls) {
        expect(channelDecision('list_channels', input).access).toBe(expected);
        expect(hook('list_channels', input)).toBe(expected);
      }
    });

  test('the discovery hook applies per-tool read overrides rather than write defaults', () => {
    setPolicies('channel', [[{ kind: 'channel', station: 'telegram', account: TG }, { write: 'deny', read: 'deny', tools: { list_channels: 'allow' } }]]);
    expect(channelDecision('list_channels', { account: TG }).access).toBe('allow');
    expect(hook('list_channels', { account: TG })).toBe('allow');
    setPolicies('channel', [[{ kind: 'channel', station: 'telegram', account: TG }, { read: 'allow', tools: { list_channels: 'ask' } }]]);
    expect(channelDecision('list_channels', { account: TG }).access).toBe('ask');
    expect(hook('list_channels', { account: TG })).toBe('ask');
  });

  for (const access of ['deny', 'ask'] as const)
    test(`roster uses the line policy (${access}) while read keeps its forwarded account override`, () => {
      setPolicies('channel', [[{ kind: 'channel', station: 'whatsapp', account: WA }, { read: access }]]);
      const restrictedLine = { line: `metro://whatsapp/${WA}/123@g.us`, account: WA_OTHER };
      const allowedLine = { line: `metro://whatsapp/${WA_OTHER}/123@g.us`, account: WA };
      const calls: [string, Record<string, unknown>, string][] = [
        ['list_members', restrictedLine, access],
        ['list_members', allowedLine, 'allow'],
        ['read', restrictedLine, 'allow'],
        ['read', allowedLine, access],
      ];
      for (const [tool, input, expected] of calls) {
        expect(channelDecision(tool, input).access).toBe(expected);
        expect(hook(tool, input)).toBe(expected);
      }
    });
});
