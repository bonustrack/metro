/**
 * An attachment that could not be fetched must reach the agent as a failure,
 * not as silence and not as a 15s timeout dressed up as one.
 *
 * Before this, a station whose download threw wrote a line to its own stderr
 * and nothing else: the message sat in `pendingAttachments` until
 * ATTACH_TIMEOUT_MS and then surfaced as "could not be fetched in time", which
 * is the right note for a download still in flight and the wrong one for a file
 * that was refused outright. WhatsApp declares `fileLength` on every media
 * node, so an over-size document is known to be un-fetchable at once — waiting
 * 15s to say so, and then blaming the clock, is not honest.
 *
 * `attachmentFailed` is therefore correlated exactly like `attachmentSaved`:
 * same `attachmentFor` id, same index bookkeeping, same caption hand-off. It
 * consumes the pending slot so the timeout fallback does not report the same
 * attachment a second time.
 *
 * The `kind` on the payload is the STATION's word for the file. A WhatsApp
 * voice note and an mp3 are both `audio/*`, so a kind derived from the mime
 * alone cannot tell them apart; when the station knows, the note says what the
 * station said.
 */

import { describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';

type Notif = { method: string; params: Record<string, unknown> };

const LINE = 'metro://whatsapp/w0/19453952815@s.whatsapp.net';
const FROM = 'metro://whatsapp/w0/user/19453952815@s.whatsapp.net';
const SELF = 'metro://claude/user/8a1857f3-4039-4da6-a4e1-611b432d2082';

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
    getStations: () => new Set(['whatsapp']),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

const message = (
  id: string,
  text: string,
  kind: string,
  name: string,
): Record<string, unknown> => ({
  event: { type: 'msg' },
  id,
  ts: '2026-08-06T08:24:52.000Z',
  station: 'whatsapp',
  line: LINE,
  from: FROM,
  fromName: 'Client Counsel',
  to: 'metro://user',
  text,
  messageId: 'MSGID001',
  payload: {
    account: 'w0',
    message_id: 'MSGID001',
    attachments: [{ kind, name, mime: 'application/pdf', size: 943_718_400 }],
  },
});

const failure = (
  forId: string,
  kind: string,
  name: string,
  reason: string,
): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_fail01',
  station: 'whatsapp',
  line: LINE,
  from: SELF,
  text: `📎 not fetched: ${reason}`,
  payload: {
    account: 'w0',
    contentType: 'attachmentFailed',
    attachmentFor: forId,
    index: 0,
    kind,
    name,
    mime: 'application/pdf',
    reason,
  },
});

const saved = (
  forId: string,
  kind: string,
  name: string,
  mime: string,
): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_saved1',
  station: 'whatsapp',
  line: LINE,
  from: SELF,
  text: '📎 saved: /tmp/nope',
  payload: {
    account: 'w0',
    contentType: 'attachmentSaved',
    attachmentFor: forId,
    index: 0,
    kind,
    attachmentPath: '/tmp/does-not-exist/msg_MSGID001_0.ogg',
    localPath: '/tmp/does-not-exist/msg_MSGID001_0.ogg',
    mime,
    name,
  },
});

const channel = (notifs: Notif[]): Notif[] =>
  notifs.filter((n) => n.method === 'notifications/claude/channel');
const contentOf = (n: Notif): string => String(n.params.content);
const metaOf = (n: Notif): Record<string, unknown> =>
  n.params.meta as Record<string, unknown>;

const REASON =
  'attachment size 943718400 exceeds limit of 104857600 bytes';

describe('a failed download reaches the agent', () => {
  test('buffering the message alone notifies nobody yet', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(
      message('msg_a', 'the whole quarter is in here', 'document', 'q3.zip'),
    );
    expect(channel(notifs)).toHaveLength(0);
  });

  test('the failure carries the caption, the sender and the reason', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(
      message('msg_b', 'the whole quarter is in here', 'document', 'q3.zip'),
    );
    await relay.handleEvent(failure('msg_b', 'document', 'q3.zip', REASON));
    const [note] = channel(notifs);
    expect(note).toBeDefined();
    expect(contentOf(note as Notif)).toContain('the whole quarter is in here');
    expect(contentOf(note as Notif)).toContain(
      '[document attachment could not be fetched: q3.zip]',
    );
    expect(contentOf(note as Notif)).toContain(`Reason: ${REASON}`);
    expect(metaOf(note as Notif)).toMatchObject({
      line: LINE,
      from: FROM,
      station: 'whatsapp',
      message_id: 'MSGID001',
      from_name: 'Client Counsel',
      kind: 'document',
      name: 'q3.zip',
      attachment_error: REASON,
    });
  });

  test('the failure note advertises no url and no local path', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(message('msg_c', 'caption', 'document', 'q3.zip'));
    await relay.handleEvent(failure('msg_c', 'document', 'q3.zip', REASON));
    const [note] = channel(notifs);
    expect(metaOf(note as Notif).url).toBeUndefined();
    expect(metaOf(note as Notif).local_path).toBeUndefined();
    expect(contentOf(note as Notif)).not.toContain('Public URL');
  });

  test('the caption is handed over once, so the timeout cannot repeat it', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(message('msg_d', 'only once', 'document', 'q3.zip'));
    await relay.handleEvent(failure('msg_d', 'document', 'q3.zip', REASON));
    await relay.handleEvent(failure('msg_d', 'document', 'q3.zip', REASON));
    const notes = channel(notifs);
    expect(notes).toHaveLength(2);
    expect(contentOf(notes[0] as Notif)).toContain('only once');
    expect(contentOf(notes[1] as Notif)).not.toContain('only once');
  });

  test('an unknown line is not a channel to shout into', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(failure('msg_never', 'document', 'x.pdf', REASON));
    expect(channel(notifs)).toHaveLength(0);
  });

  test('a message with no attachments is unaffected', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent({
      event: { type: 'msg' },
      id: 'msg_plain',
      station: 'whatsapp',
      line: LINE,
      from: FROM,
      text: 'just text',
      messageId: 'PLAIN1',
      payload: { account: 'w0' },
    });
    expect(channel(notifs)).toHaveLength(1);
    expect(contentOf(channel(notifs)[0] as Notif)).toBe('just text');
  });
});

describe("the note uses the station's kind when it has one", () => {
  test('a voice note is a voice note, not a generic audio file', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(
      message('msg_v', 'listen', 'voice', 'voice-message.ogg'),
    );
    await relay.handleEvent(
      saved('msg_v', 'voice', 'voice-message.ogg', 'audio/ogg'),
    );
    const [note] = channel(notifs);
    expect(contentOf(note as Notif)).toContain(
      '[voice attachment received: voice-message.ogg',
    );
    expect(metaOf(note as Notif).kind).toBe('voice');
  });

  test('an mp3 with the same mime family stays audio', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(message('msg_m', 'track', 'audio', 'audio.mp3'));
    await relay.handleEvent(saved('msg_m', 'audio', 'audio.mp3', 'audio/mpeg'));
    expect(metaOf(channel(notifs)[0] as Notif).kind).toBe('audio');
  });

  test('a station that sends no kind still gets one from the mime', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(message('msg_x', 'pic', 'image', 'a.jpg'));
    const ev = saved('msg_x', 'image', 'a.jpg', 'image/jpeg');
    delete (ev.payload as Record<string, unknown>).kind;
    await relay.handleEvent(ev);
    expect(metaOf(channel(notifs)[0] as Notif).kind).toBe('image');
  });
});
