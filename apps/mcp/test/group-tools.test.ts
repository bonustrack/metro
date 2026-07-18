import { describe, expect, test } from 'bun:test';
import {
  dispatchAddMembers,
  dispatchCreateGroup,
  dispatchInviteLink,
  dispatchRemoveMembers,
  unsupportedGroup,
  wrapGroupResult,
} from '../src/mcp/group-tools.ts';
import { COMMON_TOOLS } from '../src/mcp/tool-schemas.ts';

const parse = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>;

describe('group tool schemas', () => {
  test('advertises create_group, add_members, remove_members, export_invite', () => {
    for (const name of [
      'create_group',
      'add_members',
      'remove_members',
      'export_invite',
    ])
      expect(COMMON_TOOLS.some((t) => t.name === name)).toBe(true);
  });
});

describe('wrapGroupResult', () => {
  test('prefers the daemon line and echoes members/invite link', () => {
    const wrapped = wrapGroupResult('create_group', '', 'telegram-user', {
      capability: { supported: true },
      line: 'metro://telegram-user/default/42',
      id: '42',
      name: 'Support',
      members: [
        { id: '1', status: 'added' },
        { id: '2', status: 'invited', reason: 'privacy' },
      ],
      inviteLink: 'https://t.me/+abc',
    });
    expect(wrapped).toMatchObject({
      op: 'create_group',
      line: 'metro://telegram-user/default/42',
      station: 'telegram-user',
      supported: true,
      id: '42',
      inviteLink: 'https://t.me/+abc',
    });
    expect(wrapped.members).toHaveLength(2);
  });

  test('falls back to the passed line when the daemon omits one', () => {
    const wrapped = wrapGroupResult('add_members', 'metro://xmtp/tony/abc', 'xmtp', {
      capability: { supported: true },
      members: [{ id: '0xabc', status: 'added' }],
    });
    expect(wrapped.line).toBe('metro://xmtp/tony/abc');
    expect(wrapped.inviteLink).toBeUndefined();
  });
});

describe('unsupportedGroup', () => {
  test('returns a structured not-supported result', () => {
    expect(unsupportedGroup('invite_link', 'metro://discord/a/1', 'discord', 'no')).toEqual({
      op: 'invite_link',
      line: 'metro://discord/a/1',
      station: 'discord',
      supported: false,
      reason: 'no',
      members: [],
    });
  });
});

describe('dispatch base-default (never throws on unsupported)', () => {
  test('create_group requires a station', async () => {
    const res = await dispatchCreateGroup({ name: 'x' });
    expect(parse(res.content[0]!.text).supported).toBe(false);
  });

  test('create_group on an unknown station is unsupported', async () => {
    const res = await dispatchCreateGroup({ station: 'nope', name: 'x' });
    const body = parse(res.content[0]!.text);
    expect(body.supported).toBe(false);
    expect(body.station).toBe('nope');
  });

  test('create_group on the telegram bot station is unsupported (no groupOps)', async () => {
    const res = await dispatchCreateGroup({ station: 'telegram', name: 'x' });
    const body = parse(res.content[0]!.text);
    expect(body.supported).toBe(false);
    expect(body.reason).toContain('not supported on telegram');
    expect(body.members).toEqual([]);
  });

  test('add_members requires a line', async () => {
    const res = await dispatchAddMembers({});
    expect(parse(res.content[0]!.text).supported).toBe(false);
  });

  test('add_members on a telegram bot line is unsupported', async () => {
    const res = await dispatchAddMembers({ line: 'metro://telegram/123', members: ['@x'] });
    const body = parse(res.content[0]!.text);
    expect(body.station).toBe('telegram');
    expect(body.supported).toBe(false);
  });

  test('remove_members on a telegram bot line is unsupported', async () => {
    const res = await dispatchRemoveMembers({ line: 'metro://telegram/123', members: ['@x'] });
    expect(parse(res.content[0]!.text).supported).toBe(false);
  });

  test('export_invite on a discord line is unsupported (invite_link not offered)', async () => {
    const res = await dispatchInviteLink({ line: 'metro://discord/acc/123456789' });
    const body = parse(res.content[0]!.text);
    expect(body.station).toBe('discord');
    expect(body.supported).toBe(false);
    expect(body.reason).toContain('invite_link');
  });
});
