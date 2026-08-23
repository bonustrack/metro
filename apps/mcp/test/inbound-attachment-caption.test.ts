/**
 * A message that carries an attachment must also carry its caption, its sender
 * and its message id.
 *
 * `handleEvent` buffers the attachment descriptors so the later
 * `attachmentSaved` follow-up can be correlated (and so a fetch that never
 * lands still surfaces something after ATTACH_TIMEOUT_MS). That buffering
 * `return`ed before `emitMessage`, and `surfaceMedia` never read the buffered
 * text, so the caption reached the agent ONLY on the 15s timeout path: the
 * better the download worked, the more text was lost. `message_id`,
 * `line_name` and `from_name` went with it, so the agent could not even reply
 * to the message it had just been handed a file from.
 *
 * The stations diverge and the divergence is the whole point of this file:
 * discord-bot, telegram and xmtp put an `attachments` array on the envelope
 * payload and therefore buffer; the telegram-bot BOT station does not, which is
 * the only reason its captions survived. Every fixture below is shaped from
 * the real traffic captured on 2026-08-05 (tail.log), including Less's own
 * "Great caption here" on discord-bot and "Monster truck" on telegram.
 */

import { describe, expect, jest, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';

type Notif = { method: string; params: Record<string, unknown> };

/** Mirrors ATTACH_TIMEOUT_MS in src/channels/inbound.ts (not exported). */
const ATTACH_TIMEOUT_MS = 15_000;

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
    getStations: () =>
      new Set(['discord-bot', 'telegram-bot', 'telegram', 'xmtp']),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

const channelNotifs = (notifs: Notif[]): Notif[] =>
  notifs.filter((n) => n.method === 'notifications/claude/channel');

const contentOf = (n: Notif): string => String(n.params.content);
const metaOf = (n: Notif): Record<string, unknown> =>
  n.params.meta as Record<string, unknown>;

const discordMsg = (text: string): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_a8rbc9lk',
  ts: '2026-08-05T18:33:25.698Z',
  station: 'discord-bot',
  line: 'metro://discord-bot/d0/1504226489359401221',
  from: 'metro://discord-bot/d0/user/238307675501232128',
  fromName: 'bonustrack_',
  fromDisplayName: 'less',
  to: 'metro://user',
  text,
  messageId: '1534630426356879492',
  payload: {
    account: 'd0',
    attachments: [
      {
        id: '1534630426348486886',
        name: 'exploding-kittens-bot.html',
        contentType: 'text/html',
      },
    ],
  },
});

const discordSaved = (): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_j3ix2ppk',
  station: 'discord-bot',
  line: 'metro://discord-bot/d0/1504226489359401221',
  from: 'metro://user',
  text: '📎 saved: /data/.cache/metro/messenger-uploads/msg_1534630426356879_0.html',
  payload: {
    account: 'd0',
    contentType: 'attachmentSaved',
    attachmentFor: 'msg_a8rbc9lk',
    index: 0,
    attachmentPath:
      '/data/.cache/metro/messenger-uploads/msg_1534630426356879_0.html',
    localPath:
      '/data/.cache/metro/messenger-uploads/msg_1534630426356879_0.html',
    mime: 'text/html; charset=utf-8',
    name: 'exploding-kittens-bot.html',
    url: 'https://mcp.metro.box/attach/msg_1534630426356879_0.html?token=at_grant',
  },
});

const telegramMsg = (): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_69awj0yf',
  station: 'telegram',
  line: 'metro://telegram/default/25220238',
  lineName: '@bonustrack',
  from: 'metro://telegram/default/user/25220238',
  fromName: '@bonustrack',
  fromDisplayName: 'less, Snapshot',
  to: 'metro://user',
  text: 'Monster truck [photo]',
  messageId: '1976',
  payload: {
    account: 'default',
    message_id: '1976',
    attachments: [{ kind: 'image' }],
  },
});

const telegramSaved = (): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_saved_1976',
  station: 'telegram',
  line: 'metro://telegram/default/25220238',
  from: 'metro://telegram/default/self',
  text: '📎 saved: /data/.cache/metro/messenger-uploads/msg_1976_0.jpg',
  payload: {
    account: 'default',
    contentType: 'attachmentSaved',
    attachmentFor: 'msg_69awj0yf',
    index: 0,
    attachmentPath: '/data/.cache/metro/messenger-uploads/msg_1976_0.jpg',
    localPath: '/data/.cache/metro/messenger-uploads/msg_1976_0.jpg',
    mime: 'image/jpeg',
    name: 'msg_1976_0.jpg',
    url: 'https://mcp.metro.box/attach/msg_1976_0.jpg?token=at_grant',
  },
});

const xmtpMsg = (): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_xm1',
  station: 'xmtp',
  line: 'metro://xmtp/x0/8ff47a52b0137e61e88b9c85db762b48',
  from: 'metro://xmtp/x0/user/f75807c6cd34a4c5b88fbc6684eae825',
  to: 'metro://user',
  text: 'here is the deck [file: deck.pdf]',
  messageId: '82c863542725f2d7',
  payload: {
    account: 'x0',
    contentType: 'remoteStaticAttachment',
    attachments: [{ kind: 'file', name: 'deck.pdf' }],
  },
});

const xmtpSaved = (): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_xm1_saved',
  station: 'xmtp',
  line: 'metro://xmtp/x0/8ff47a52b0137e61e88b9c85db762b48',
  from: 'metro://xmtp/x0/self',
  text: '📎 saved: /data/.cache/metro/messenger-uploads/msg_82c863542725f2d7_0.pdf',
  payload: {
    account: 'x0',
    contentType: 'attachmentSaved',
    attachmentFor: 'msg_xm1',
    index: 0,
    attachmentPath:
      '/data/.cache/metro/messenger-uploads/msg_82c863542725f2d7_0.pdf',
    localPath: '/data/.cache/metro/messenger-uploads/msg_82c863542725f2d7_0.pdf',
    mime: 'application/pdf',
    name: 'deck.pdf',
    url: 'https://mcp.metro.box/attach/msg_82c863542725f2d7_0.pdf?token=at_grant',
  },
});

describe('discord-bot: the caption reaches the agent with the attachment', () => {
  test("Less's real 'Great caption here' survives the happy path", async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(
      discordMsg('Great caption here [file: exploding-kittens-bot.html]'),
    );
    await relay.handleEvent(discordSaved());

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    const only = channel[0] as Notif;
    expect(contentOf(only)).toStartWith(
      'Great caption here [file: exploding-kittens-bot.html]\n',
    );
    expect(contentOf(only)).toContain('[file attachment received');
    expect(metaOf(only).message_id).toBe('1534630426356879492');
    expect(metaOf(only).from_name).toBe('bonustrack_');
    expect(metaOf(only).from_display_name).toBe('less');
    expect(metaOf(only).from).toBe(
      'metro://discord-bot/d0/user/238307675501232128',
    );
  });
});

describe('telegram: the caption reaches the agent with the attachment', () => {
  test("Less's real 'Monster truck' survives the happy path", async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(telegramMsg());
    await relay.handleEvent(telegramSaved());

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    const only = channel[0] as Notif;
    expect(contentOf(only)).toStartWith('Monster truck [photo]\n');
    expect(contentOf(only)).toContain('[image attachment received');
    expect(metaOf(only).message_id).toBe('1976');
    expect(metaOf(only).line_name).toBe('@bonustrack');
    expect(metaOf(only).from_name).toBe('@bonustrack');
  });
});

describe('xmtp: the caption reaches the agent with the attachment', () => {
  test('a captioned remote attachment carries text and identity', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(xmtpMsg());
    await relay.handleEvent(xmtpSaved());

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    const only = channel[0] as Notif;
    expect(contentOf(only)).toStartWith('here is the deck [file: deck.pdf]\n');
    expect(metaOf(only).message_id).toBe('82c863542725f2d7');
    expect(metaOf(only).station).toBe('xmtp');
  });
});

describe('telegram-bot (bot): the station that never buffered is unchanged', () => {
  test('the caption is emitted on its own and the media note follows', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent({
      event: { type: 'msg' },
      id: 'msg_y48j9o5s',
      station: 'telegram-bot',
      line: 'metro://telegram-bot/t0/25220238',
      lineName: 'less',
      from: 'metro://telegram-bot/t0/user/25220238',
      fromName: '@bonustrack',
      to: 'metro://user',
      text: 'a caption on the bot station [image]',
      messageId: '1569',
      payload: { account: 't0', message_id: 1569, photo: [{ file_id: 'f1' }] },
    });
    await relay.handleEvent({
      event: { type: 'msg' },
      id: 'msg_saved_1569',
      station: 'telegram-bot',
      line: 'metro://telegram-bot/t0/25220238',
      from: 'metro://user',
      text: '📎 saved: /data/.cache/metro/messenger-uploads/msg_1569_0.jpg',
      payload: {
        account: 't0',
        contentType: 'attachmentSaved',
        attachmentFor: 'msg_y48j9o5s',
        index: 0,
        attachmentPath: '/data/.cache/metro/messenger-uploads/msg_1569_0.jpg',
        localPath: '/data/.cache/metro/messenger-uploads/msg_1569_0.jpg',
        mime: 'image/jpeg',
        url: 'https://mcp.metro.box/attach/msg_1569_0.jpg?token=at_grant',
      },
    });

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(2);
    expect(contentOf(channel[0] as Notif)).toBe(
      'a caption on the bot station [image]',
    );
    expect(metaOf(channel[0] as Notif).message_id).toBe('1569');
    expect(contentOf(channel[1] as Notif)).toStartWith(
      '[image attachment received',
    );
    expect(contentOf(channel[1] as Notif)).not.toContain('a caption on the bot');
  });
});

describe('the caption is delivered exactly once', () => {
  test('two attachments on one message produce two notes and one caption', async () => {
    const { relay, notifs } = makeRelay();
    const msg = discordMsg('two files, one caption');
    (msg.payload as { attachments: unknown[] }).attachments = [
      { name: 'a.png' },
      { name: 'b.png' },
    ];

    await relay.handleEvent(msg);
    await relay.handleEvent(discordSaved());
    const second = discordSaved();
    (second.payload as Record<string, unknown>).index = 1;
    (second.payload as Record<string, unknown>).name = 'b.png';
    await relay.handleEvent(second);

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(2);
    expect(contentOf(channel[0] as Notif)).toStartWith('two files, one caption');
    expect(contentOf(channel[1] as Notif)).not.toContain('one caption');
    expect(metaOf(channel[1] as Notif).message_id).toBe(
      '1534630426356879492',
    );
  });

  test('the timeout fallback does not repeat a caption already surfaced', async () => {
    const { relay, notifs } = makeRelay();
    const msg = discordMsg('one lands, one hangs');
    (msg.payload as { attachments: unknown[] }).attachments = [
      { name: 'a.html' },
      { name: 'never.html' },
    ];

    jest.useFakeTimers();
    try {
      await relay.handleEvent(msg);
      await relay.handleEvent(discordSaved());
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1_000);
    } finally {
      jest.useRealTimers();
    }
    await Bun.sleep(10);

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(2);
    expect(contentOf(channel[0] as Notif)).toStartWith('one lands, one hangs');
    expect(contentOf(channel[1] as Notif)).toBe(
      '[attachment(s) could not be fetched in time: never.html]',
    );
  });

  test('a download that never lands still surfaces the caption at the timeout', async () => {
    const { relay, notifs } = makeRelay();

    jest.useFakeTimers();
    try {
      await relay.handleEvent(discordMsg('this fetch will hang'));
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1_000);
    } finally {
      jest.useRealTimers();
    }
    await Bun.sleep(10);

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    expect(contentOf(channel[0] as Notif)).toStartWith('this fetch will hang\n');
    expect(contentOf(channel[0] as Notif)).toContain(
      'could not be fetched in time',
    );
    expect(metaOf(channel[0] as Notif).message_id).toBe(
      '1534630426356879492',
    );
  });
});

describe('the media note tells the truth about where the file is', () => {
  test('it names the daemon host and does not order a local Read', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(discordMsg('caption'));
    await relay.handleEvent(discordSaved());

    const content = contentOf(channelNotifs(notifs)[0] as Notif);
    expect(content).toContain(
      'Public URL: https://mcp.metro.box/attach/msg_1534630426356879_0.html?token=at_grant',
    );
    expect(content).toContain(
      'Daemon-host path: /data/.cache/metro/messenger-uploads/msg_1534630426356879_0.html',
    );
    expect(content).toContain('The path is on the daemon host');
    expect(content).not.toContain('Use the Read tool on that absolute path');
    expect(content).not.toContain('Saved locally at');
  });

  test('with no public url configured it says the file is daemon-only', async () => {
    const { relay, notifs } = makeRelay();
    const saved = discordSaved();
    delete (saved.payload as Record<string, unknown>).url;

    await relay.handleEvent(discordMsg(''));
    await relay.handleEvent(saved);

    const note = channelNotifs(notifs)[0] as Notif;
    expect(contentOf(note)).not.toContain('Public URL');
    expect(contentOf(note)).toContain(
      'readable only by an agent running there',
    );
    expect(metaOf(note).url).toBeUndefined();
    expect(metaOf(note).local_path).toBe(
      '/data/.cache/metro/messenger-uploads/msg_1534630426356879_0.html',
    );
  });
});

describe('paths that must not change', () => {
  test('a plain message with no attachments is untouched', async () => {
    const { relay, notifs } = makeRelay();
    const plain = discordMsg('just text');
    delete plain.payload;

    await relay.handleEvent(plain);

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    expect(contentOf(channel[0] as Notif)).toBe('just text');
  });

  test('an attachment with no caption surfaces the note alone', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(discordMsg(''));
    await relay.handleEvent(discordSaved());

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    expect(contentOf(channel[0] as Notif)).toStartWith(
      '[file attachment received',
    );
  });

  test('an unsolicited attachmentSaved on a known line still surfaces', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(discordMsg('a plain earlier message'));
    const orphan = discordSaved();
    (orphan.payload as Record<string, unknown>).attachmentFor = 'msg_unknown';
    await relay.handleEvent(orphan);

    const channel = channelNotifs(notifs);
    const note = channel[channel.length - 1] as Notif;
    expect(contentOf(note)).toStartWith('[file attachment received');
    expect(metaOf(note).from).toBe('metro://attachment');
    expect(metaOf(note).message_id).toBeUndefined();
  });
});
