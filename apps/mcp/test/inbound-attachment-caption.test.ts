/**
 * A message that carries an attachment also carries its caption.
 *
 * `handleEvent` buffers the attachment descriptors so the later
 * `attachmentSaved` follow-up can be correlated (and so a fetch that never
 * lands still surfaces something after ATTACH_TIMEOUT_MS). That buffering used
 * to `return` before `emitMessage`, so the caption was only ever surfaced on
 * the timeout path: on the happy path the agent got the media note and no text
 * at all. Observed live on Discord (two captioned images, 2026-07-27).
 *
 * A station's text projection is `caption + [tag]` (discord `format.ts`), so an
 * attachment with no caption still has text; only a truly empty projection is
 * silent. Reacts keep going through the media note alone.
 */

import { describe, expect, jest, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';

type Notif = { method: string; params: Record<string, unknown> };

/** Mirrors ATTACH_TIMEOUT_MS in src/channels/inbound.ts (not exported). */
const ATTACH_TIMEOUT_MS = 15_000;

function makeRelay(): { relay: InboundRelay; notifs: Notif[] } {
  const notifs: Notif[] = [];
  const fakeMcp = {
    notification: (n: Notif) => {
      notifs.push(n);
      return Promise.resolve();
    },
  };
  const relay = new InboundRelay({
    mcp: fakeMcp as never,
    log: () => {},
    getStations: () => new Set(['discord']),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

const withAttachment = (
  id: string,
  text: string,
  type = 'msg',
): Record<string, unknown> => ({
  id,
  ts: '2026-07-27T12:00:00.000Z',
  station: 'discord',
  line: 'metro://discord/acc/channel/1',
  lineName: 'general',
  from: 'metro://discord/acc/user/less',
  fromName: 'bonustrack_',
  fromDisplayName: 'Less',
  to: 'metro://discord/acc/channel/1',
  text,
  messageId: `disc-${id}`,
  event: { type },
  payload: {
    attachments: [{ kind: 'image', name: 'IMG_0001.png' }],
  },
});

const attachmentSaved = (forId: string): Record<string, unknown> => ({
  id: `${forId}-saved`,
  ts: '2026-07-27T12:00:01.000Z',
  station: 'discord',
  line: 'metro://discord/acc/channel/1',
  from: 'metro://discord/acc/self',
  text: '📎 saved: /data/attachments/IMG_0001.png',
  payload: {
    contentType: 'attachmentSaved',
    attachmentFor: forId,
    index: 0,
    attachmentPath: '/data/attachments/IMG_0001.png',
    localPath: '/data/attachments/IMG_0001.png',
    mime: 'image/png',
    name: 'IMG_0001.png',
  },
});

const channelNotifs = (notifs: Notif[]): Notif[] =>
  notifs.filter((n) => n.method === 'notifications/claude/channel');

describe('inbound message with an attachment', () => {
  test('surfaces the caption as well as the media note', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(withAttachment('att-1', 'look at this chart'));
    await relay.handleEvent(attachmentSaved('att-1'));

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(2);
    expect(channel[0].params.content).toBe('look at this chart');
    const meta = channel[0].params.meta as Record<string, unknown>;
    expect(meta.message_id).toBe('disc-att-1');
    expect(meta.line).toBe('metro://discord/acc/channel/1');
    expect(meta.from_name).toBe('bonustrack_');
    expect(meta.from_display_name).toBe('Less');
    expect(channel[1].params.content).toContain('[image attachment received');
    expect(channel[1].params.content).toContain('/data/attachments/IMG_0001.png');
  });

  test('emits no text message when the projection is empty', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(withAttachment('att-2', ''));
    await relay.handleEvent(attachmentSaved('att-2'));

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    expect(channel[0].params.content).toContain('[image attachment received');
  });

  test('a react carrying an attachment stays a media note only', async () => {
    const { relay, notifs } = makeRelay();

    await relay.handleEvent(withAttachment('att-3', '[react 👀]', 'react'));
    await relay.handleEvent(attachmentSaved('att-3'));

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    expect(channel[0].params.content).toContain('[image attachment received');
  });

  test('the fetch-timeout fallback does not repeat a surfaced caption', async () => {
    const { relay, notifs } = makeRelay();

    jest.useFakeTimers();
    try {
      await relay.handleEvent(withAttachment('att-5', 'this fetch will hang'));
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1_000);
    } finally {
      jest.useRealTimers();
    }

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(2);
    expect(channel[0].params.content).toBe('this fetch will hang');
    expect(channel[1].params.content).toBe(
      '[attachment(s) could not be fetched in time: IMG_0001.png]',
    );
  });

  test('a message with no attachment is unaffected', async () => {
    const { relay, notifs } = makeRelay();

    const plain = withAttachment('att-4', 'just text');
    delete plain.payload;
    await relay.handleEvent(plain);

    const channel = channelNotifs(notifs);
    expect(channel.length).toBe(1);
    expect(channel[0].params.content).toBe('just text');
  });
});
