import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { dispatchGetProfile, GET_PROFILE_TOOL, profileTarget } from '../src/mcp/profile-lookup.ts';
import { scopeDenied } from '../src/mcp/tool-dispatch.ts';
import { setAgentMap } from '../src/agents/map.ts';

interface Seen {
  train: string;
  action: string;
  args: Record<string, unknown>;
}

let seen: Seen[] = [];

beforeEach(() => {
  seen = [];
  setTrainCallBackend((train, action, args) => {
    seen.push({ train, action, args: args as Record<string, unknown> });
    return Promise.resolve({ result: { id: (args as { user: string }).user, name: 'alice-stage.stage.base.eth', display_name: 'Alice', about: 'Onboarding on Stage', avatar: 'ipfs://bafy1', address: '0xa94c' } });
  });
});

afterEach(() => {
  setAgentMap({}, {});
});

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n');

describe('the get_profile tool', () => {
  test('takes the from of a message and names the station, the account and the person', () => {
    expect(GET_PROFILE_TOOL.inputSchema.required).toEqual(['from']);
    expect(profileTarget({ from: 'metro://xmtp/a1/user/8f3e' })).toMatchObject({ account: 'a1', user: '8f3e' });
    expect(profileTarget({ from: 'metro://whatsapp/w0/user/4179@s.whatsapp.net' })).toMatchObject({ account: 'w0', user: '4179@s.whatsapp.net' });
    expect(profileTarget({ from: 'metro://telegram/user/42' })).toMatchObject({ refused: expect.stringContaining('is not a person') as unknown });
    expect(profileTarget({})).toEqual({ refused: 'get_profile requires `from`' });
    expect(profileTarget({ from: 'metro://xmtp/a1/conv9' })).toMatchObject({ refused: expect.stringContaining('is not a person') as unknown });
    expect(profileTarget({ from: 'metro://pigeon/a/user/1' })).toEqual({ refused: 'no station named pigeon' });
    expect(profileTarget({ from: 'metro://threema/t0/user/ALICE001' })).toEqual({ refused: 'threema has no profile metro can read' });
  });

  test('asks the train for the profile and hands the answer back', async () => {
    const res = await dispatchGetProfile({ from: 'metro://xmtp/a1/user/8f3e' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(text(res))).toEqual({ id: '8f3e', name: 'alice-stage.stage.base.eth', display_name: 'Alice', about: 'Onboarding on Stage', avatar: 'ipfs://bafy1', address: '0xa94c' });
    expect(seen).toEqual([{ train: 'xmtp', action: 'profile', args: { account: 'a1', user: '8f3e' } }]);
    expect(text(await dispatchGetProfile({ from: 'metro://threema/t0/user/ALICE001' }))).toContain('no profile metro can read');
    expect(seen).toHaveLength(1);
  });

  test('scope: the account in the from must belong to the caller', () => {
    setAgentMap({ 'xmtp/mine': 'agentA0001', 'xmtp/theirs': 'agentB0002' }, {});
    const me = { kind: 'agent', agentId: 'agentA0001' } as const;
    expect(scopeDenied(me, 'get_profile', { from: 'metro://xmtp/mine/user/8f3e' })).toBe(false);
    expect(scopeDenied(me, 'get_profile', { from: 'metro://xmtp/theirs/user/8f3e' })).toBe(true);
    expect(scopeDenied(me, 'get_profile', { from: 'nonsense' })).toBe(true);
    expect(scopeDenied(undefined, 'get_profile', { from: 'metro://xmtp/mine/user/8f3e' })).toBe(true);
  });
});
