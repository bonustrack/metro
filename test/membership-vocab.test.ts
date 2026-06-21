import { describe, expect, test } from 'bun:test';
import {
  parseMemberArgs,
  resolveMembers,
} from '../src/stations/xmtp/member-args.ts';

describe('group-membership vocabulary (addresses/inboxIds) with back-compat', () => {
  const ADDR = '0x839d5980bAca12822Dd3365A9f1b6Ba5B636a464';
  const INBOX = 'inbox-abc';

  test('resolveMembers reads the standardized addresses/inboxIds', () => {
    expect(resolveMembers({ addresses: [ADDR], inboxIds: [INBOX] })).toEqual({
      addrs: [ADDR],
      inboxes: [INBOX],
    });
  });

  test('resolveMembers reads the legacy memberAddresses/memberInboxIds', () => {
    expect(
      resolveMembers({ memberAddresses: [ADDR], memberInboxIds: [INBOX] }),
    ).toEqual({ addrs: [ADDR], inboxes: [INBOX] });
  });

  test('standardized names win over legacy when both are present', () => {
    expect(
      resolveMembers({
        addresses: [ADDR],
        memberAddresses: ['0xlegacy'],
        inboxIds: [INBOX],
        memberInboxIds: ['legacy-inbox'],
      }),
    ).toEqual({ addrs: [ADDR], inboxes: [INBOX] });
  });

  test('non-string entries are filtered out under both vocabularies', () => {
    expect(resolveMembers({ addresses: [ADDR, '', 1] })).toEqual({
      addrs: [ADDR],
      inboxes: [],
    });
    expect(resolveMembers({ memberInboxIds: [INBOX, null] })).toEqual({
      addrs: [],
      inboxes: [INBOX],
    });
  });

  test('parseMemberArgs (addMembers/removeMembers) accepts standardized names', () => {
    expect(parseMemberArgs({ line: 'l', addresses: [ADDR] }, 'addMembers')).toEqual(
      { line: 'l', addrs: [ADDR], inboxes: [] },
    );
  });

  test('parseMemberArgs also accepts the legacy member* aliases', () => {
    expect(
      parseMemberArgs(
        { line: 'l', memberAddresses: [ADDR], memberInboxIds: [INBOX] },
        'removeMembers',
      ),
    ).toEqual({ line: 'l', addrs: [ADDR], inboxes: [INBOX] });
  });

  test('parseMemberArgs requires a line', () => {
    expect(() => parseMemberArgs({ addresses: [ADDR] }, 'addMembers')).toThrow(
      /requires a `line`/,
    );
  });

  test('parseMemberArgs requires at least one membership list', () => {
    expect(() => parseMemberArgs({ line: 'l' }, 'addMembers')).toThrow(
      /requires addresses\[\] or inboxIds\[\]/,
    );
  });
});
