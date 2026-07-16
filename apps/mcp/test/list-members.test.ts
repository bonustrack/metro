import { describe, expect, test } from 'bun:test';
import {
  dispatchListMembers,
  unsupportedMembers,
  wrapMemberList,
} from '../src/mcp/member-tools.ts';
import { COMMON_TOOLS } from '../src/mcp/tool-schemas.ts';

const parse = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>;

describe('list_members tool', () => {
  test('is advertised as a common tool', () => {
    expect(COMMON_TOOLS.some((t) => t.name === 'list_members')).toBe(true);
  });

  test('wrapMemberList derives memberCount from the station list', () => {
    const wrapped = wrapMemberList('metro://xmtp/tony/abc', 'xmtp', {
      members: [{ id: 'a' }, { id: 'b' }],
      capability: { supported: true, complete: true, total: 2 },
    });
    expect(wrapped.memberCount).toBe(2);
    expect(wrapped.station).toBe('xmtp');
    expect(wrapped.capability.complete).toBe(true);
  });

  test('unsupportedMembers returns an empty roster with a reason', () => {
    const out = unsupportedMembers('metro://webhook/x', 'webhook', 'no roster');
    expect(out).toEqual({
      line: 'metro://webhook/x',
      station: 'webhook',
      memberCount: 0,
      members: [],
      capability: { supported: false, complete: false, reason: 'no roster' },
    });
  });

  test('dispatch requires a line', async () => {
    const res = await dispatchListMembers({});
    expect(parse(res.content[0]!.text).capability).toMatchObject({
      supported: false,
    });
  });

  test('dispatch returns unsupported for stations without a member roster', async () => {
    const res = await dispatchListMembers({ line: 'metro://webhook/abc' });
    const body = parse(res.content[0]!.text);
    expect(body.station).toBe('webhook');
    expect((body.capability as { supported: boolean }).supported).toBe(false);
    expect(body.members).toEqual([]);
  });
});
