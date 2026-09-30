import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { GroupMessageKind } from '@xmtp/node-sdk';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { encodeDeleteMessage } from '../src/codecs.ts';

const accountId = 'delete-test';
const line = `metro://xmtp/${accountId}/group1`;
const self = 'self-inbox';
const text = { authorityId: 'xmtp.org', typeId: 'text', versionMajor: 1, versionMinor: 0 };

interface Stored {
  conversationId: string;
  senderInboxId: string;
  kind: GroupMessageKind;
  contentType: { typeId: string };
}

const own = (typeId = 'text', kind = GroupMessageKind.Application): Stored =>
  ({ conversationId: 'group1', senderInboxId: self, kind, contentType: { ...text, typeId } });

let out: string[] = [];
let restore = () => {};

beforeEach(() => {
  out = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  restore = () => spy.mockRestore();
});
afterEach(() => {
  restore();
  accounts.delete(accountId);
});

function fixture(messages: Record<string, Stored>) {
  const sent: { content: unknown; opts: unknown }[] = [];
  const group = {
    id: 'group1',
    send: async (content: unknown, opts: unknown) => {
      sent.push({ content, opts });
      return 'delete-request-id';
    },
  };
  const client = {
    inboxId: self,
    conversations: {
      getConversationById: async () => group,
      getMessageById: (id: string) => messages[id],
    },
  };
  accounts.set(accountId, { cfg: { id: accountId }, client, inboxId: self } as unknown as Account);
  return sent;
}

async function remove(messageId: string): Promise<{ result?: { messageId: string }; error?: string }> {
  await handleCall({ op: 'call', id: 'd', action: 'delete', args: { line, messageId } });
  const response = out.map((l) => JSON.parse(l) as { op: string }).find((e) => e.op === 'response');
  return response as { result?: { messageId: string }; error?: string };
}

describe('xmtp delete', () => {
  test('encodes the XIP-76 request Stage sends', () => {
    const id = 'ab'.repeat(32);
    const encoded = encodeDeleteMessage(id);
    expect(encoded.type).toEqual({ authorityId: 'xmtp.org', typeId: 'deleteMessage', versionMajor: 1, versionMinor: 0 });
    expect(encoded.parameters).toEqual({});
    expect(encoded.fallback).toBeUndefined();
    expect([...encoded.content]).toEqual([0x0a, 64, ...new TextEncoder().encode(id)]);
    expect(encodeDeleteMessage('x'.repeat(200)).content.slice(0, 3)).toEqual(new Uint8Array([0x0a, 0xc8, 0x01]));
  });

  test('deletes an own message without a push', async () => {
    const sent = fixture({ m1: own() });
    const response = await remove('m1');
    expect(response.result).toEqual({ messageId: 'delete-request-id' });
    expect(sent).toEqual([{ content: encodeDeleteMessage('m1'), opts: { shouldPush: false } }]);
  });

  test('refuses a message someone else sent', async () => {
    const sent = fixture({ m1: { ...own(), senderInboxId: 'peer-inbox' } });
    expect((await remove('m1')).error).toContain('only your own messages can be deleted');
    expect(sent).toEqual([]);
  });

  test.each([
    ['unknown', {}],
    ['in another conversation', { m1: { ...own(), conversationId: 'group2' } }],
  ])('refuses a message %s', async (_, messages: Record<string, Stored>) => {
    const sent = fixture(messages);
    expect((await remove('m1')).error).toBe('message m1 is not in this conversation');
    expect(sent).toEqual([]);
  });

  test.each([
    ['a group update', own('group_updated', GroupMessageKind.MembershipChange)],
    ['an already deleted message', own('deletedMessage')],
    ['a delete request', own('deleteMessage')],
  ])('refuses %s', async (_, message: Stored) => {
    const sent = fixture({ m1: message });
    expect((await remove('m1')).error).toBe('message m1 cannot be deleted');
    expect(sent).toEqual([]);
  });
});
