import { describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { addressedBy } from '../src/channels/addressed.ts';

type Notif = { method: string; params: Record<string, unknown> };

function makeRelay(): { relay: InboundRelay; notifs: Notif[] } {
  const notifs: Notif[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: Notif) => {
        notifs.push(n);
        return Promise.resolve();
      },
    } as never,
    log: () => undefined,
    getStations: () => new Set(['discord-bot']),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

const message = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `msg_${id}`,
  ts: '2026-09-06T00:00:00.000Z',
  station: 'discord-bot',
  line: 'metro://discord-bot/d0/guild/1/channel/2',
  from: 'metro://discord-bot/d0/user/less',
  fromName: 'less',
  to: 'metro://discord-bot/d0/guild/1/channel/2',
  text: 'Hello???',
  messageId: id,
  event: { type: 'msg' },
  ...over,
});

async function metaOf(relay: InboundRelay, notifs: Notif[], ev: Record<string, unknown>): Promise<Record<string, unknown>> {
  notifs.length = 0;
  await relay.handleEvent(ev);
  const channel = notifs.filter((n) => n.method === 'notifications/claude/channel');
  expect(channel.length).toBe(1);
  return channel[0]?.params.meta as Record<string, unknown>;
}

describe('the addressed verdict on a relayed message', () => {
  test('a plain room message carries no verdict and no reply target', async () => {
    const { relay, notifs } = makeRelay();
    const meta = await metaOf(relay, notifs, message('m1'));
    expect(meta.addressed).toBeUndefined();
    expect(meta.reply_to).toBeUndefined();
  });

  test('a private chat is direct, a mention is mention, and direct wins over both', async () => {
    const { relay, notifs } = makeRelay();
    expect((await metaOf(relay, notifs, message('m2', { isPrivate: true }))).addressed).toBe('direct');
    expect((await metaOf(relay, notifs, message('m3', { mentionsSelf: true }))).addressed).toBe('mention');
    expect(
      (await metaOf(relay, notifs, message('m4', { isPrivate: true, mentionsSelf: true, replyToSelf: true }))).addressed,
    ).toBe('direct');
  });

  test('a reply the station knows is ours is a reply, and the target id rides along', async () => {
    const { relay, notifs } = makeRelay();
    const meta = await metaOf(relay, notifs, message('m5', { replyTo: 'bot-said-1', replyToSelf: true, event: { type: 'reply', replyTo: 'bot-said-1' } }));
    expect(meta.addressed).toBe('reply');
    expect(meta.reply_to).toBe('bot-said-1');
  });

  test('a reply to a message this session sent is a reply even when the station cannot tell', async () => {
    const { relay, notifs } = makeRelay();
    relay.noteSent('bot-said-2');
    const known = await metaOf(relay, notifs, message('m6', { replyTo: 'bot-said-2', event: { type: 'reply', replyTo: 'bot-said-2' } }));
    expect(known.addressed).toBe('reply');
    const stranger = await metaOf(relay, notifs, message('m7', { replyTo: 'someone-else-9', event: { type: 'reply', replyTo: 'someone-else-9' } }));
    expect(stranger.addressed).toBeUndefined();
    expect(stranger.reply_to).toBe('someone-else-9');
  });

  test('the sent-id memory is bounded', () => {
    const { relay } = makeRelay();
    for (let i = 0; i < 2_500; i += 1) relay.noteSent(`id-${String(i)}`);
    expect(addressedBy({}, 'id-0', new Set())).toBeUndefined();
    relay.noteSent('');
  });

  test('addressedBy ranks direct, mention, reply and needs a literal true', () => {
    const none = new Set<string>();
    expect(addressedBy({ isPrivate: 'yes' }, '', none)).toBeUndefined();
    expect(addressedBy({ mentionsSelf: 1 }, '', none)).toBeUndefined();
    expect(addressedBy({ replyToSelf: true }, '', none)).toBe('reply');
    expect(addressedBy({}, 'x', new Set(['x']))).toBe('reply');
    expect(addressedBy({}, '', new Set(['']))).toBeUndefined();
    expect(addressedBy({ mentionsSelf: true, replyToSelf: true }, '', none)).toBe('mention');
  });
});
