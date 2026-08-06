import { describe, expect, test } from 'bun:test';
import type { WAMessageKey } from 'baileys';
import { makeOutbox } from '../src/outbox.ts';

const LID_DM = '71425507483880@lid';

const sentKey = (id: string, jid = LID_DM): WAMessageKey => ({
  remoteJid: jid,
  fromMe: true,
  id,
});

describe('whatsapp outbox', () => {
  test('a message we sent can be produced again for a retry request', () => {
    const outbox = makeOutbox();
    outbox.remember(sentKey('M1'), { conversation: 'hello' });
    expect(outbox.lookup(sentKey('M1'))).toEqual({ conversation: 'hello' });
  });

  test('a lid chat and a phone chat with the same id are different messages', () => {
    const outbox = makeOutbox();
    outbox.remember(sentKey('SAME', LID_DM), { conversation: 'over lid' });
    outbox.remember(sentKey('SAME', '19453952815@s.whatsapp.net'), {
      conversation: 'over phone',
    });
    expect(outbox.lookup(sentKey('SAME', LID_DM))).toEqual({
      conversation: 'over lid',
    });
    expect(
      outbox.lookup(sentKey('SAME', '19453952815@s.whatsapp.net')),
    ).toEqual({ conversation: 'over phone' });
  });

  test('an inbound message is never stored, only what we sent can be resent', () => {
    const outbox = makeOutbox();
    outbox.remember({ remoteJid: LID_DM, fromMe: false, id: 'THEIRS' }, {
      conversation: 'theirs',
    });
    expect(
      outbox.lookup({ remoteJid: LID_DM, fromMe: false, id: 'THEIRS' }),
    ).toBeUndefined();
  });

  test('a key with no id or no chat is ignored rather than stored under a bad slot', () => {
    const outbox = makeOutbox();
    outbox.remember({ remoteJid: LID_DM, fromMe: true }, { conversation: 'a' });
    outbox.remember({ fromMe: true, id: 'M2' }, { conversation: 'b' });
    expect(outbox.lookup(sentKey('M2'))).toBeUndefined();
  });

  test('the oldest send is dropped once the cap is reached', () => {
    const outbox = makeOutbox(2);
    outbox.remember(sentKey('M1'), { conversation: '1' });
    outbox.remember(sentKey('M2'), { conversation: '2' });
    outbox.remember(sentKey('M3'), { conversation: '3' });
    expect(outbox.lookup(sentKey('M1'))).toBeUndefined();
    expect(outbox.lookup(sentKey('M2'))).toEqual({ conversation: '2' });
    expect(outbox.lookup(sentKey('M3'))).toEqual({ conversation: '3' });
  });

  test('re-sending the same id refreshes it instead of ageing out', () => {
    const outbox = makeOutbox(2);
    outbox.remember(sentKey('M1'), { conversation: '1' });
    outbox.remember(sentKey('M2'), { conversation: '2' });
    outbox.remember(sentKey('M1'), { conversation: '1 again' });
    outbox.remember(sentKey('M3'), { conversation: '3' });
    expect(outbox.lookup(sentKey('M1'))).toEqual({ conversation: '1 again' });
    expect(outbox.lookup(sentKey('M2'))).toBeUndefined();
  });
});
