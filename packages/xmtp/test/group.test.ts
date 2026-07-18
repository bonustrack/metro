import { describe, expect, test } from 'bun:test';
import { memberOutcomes, splitMembers } from '../src/group-members.ts';

describe('xmtp splitMembers', () => {
  test('classifies generic members into addresses vs inboxIds', () => {
    const { addrs, inboxes } = splitMembers({
      members: [
        '0x1111111111111111111111111111111111111111',
        'a'.repeat(64),
      ],
    });
    expect(addrs).toEqual(['0x1111111111111111111111111111111111111111']);
    expect(inboxes).toEqual(['a'.repeat(64)]);
  });

  test('merges explicit addresses/inboxIds and dedupes', () => {
    const addr = '0x2222222222222222222222222222222222222222';
    const { addrs, inboxes } = splitMembers({
      addresses: [addr],
      inboxIds: ['b'.repeat(64)],
      members: [addr, 'c'.repeat(64)],
    });
    expect(addrs).toEqual([addr]);
    expect(inboxes.sort()).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
  });

  test('non-address, non-inbox strings default to inboxIds', () => {
    const { addrs, inboxes } = splitMembers({ members: ['someInboxId'] });
    expect(addrs).toEqual([]);
    expect(inboxes).toEqual(['someInboxId']);
  });
});

describe('xmtp memberOutcomes', () => {
  test('labels every member with the given status', () => {
    const out = memberOutcomes(['0xabc'], ['inbox1'], 'added');
    expect(out).toEqual([
      { id: '0xabc', status: 'added' },
      { id: 'inbox1', status: 'added' },
    ]);
  });
});
