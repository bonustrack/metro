import { describe, expect, test } from 'bun:test';
import type { Conversation, DecodedMessage } from '@xmtp/node-sdk';
import { envelope } from '../src/emit.ts';

const message = { id: 'm1', content: 'hello', contentType: { typeId: 'text' }, sentAt: new Date(0), senderInboxId: 'peer' } as unknown as DecodedMessage;

class FakeDm {
  readonly id = 'dm-1';

  get peerInboxId(): string {
    return 'peer';
  }
}

describe('an inbound XMTP message', () => {
  test('is private in a DM, whose peer node-sdk 6 reads through a getter', () => {
    expect(envelope('acct', message, new FakeDm() as unknown as Conversation).is_private).toBe(true);
  });

  test('is not private in a group', () => {
    expect(envelope('acct', message, { id: 'group-1' } as unknown as Conversation).is_private).toBe(false);
  });
});
