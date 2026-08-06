/**
 * WhatsApp inbound media, end of the station side.
 *
 * The envelope now carries `payload.attachments`, which is what makes the relay
 * buffer the message and hand its caption to the media note (#139) instead of
 * emitting the text on its own. The station follows with either an
 * `attachmentSaved` or an `attachmentFailed` event for the same envelope id.
 *
 * `has_media` is gone. `trainEventToMetroEvent` (daemon/http.ts) builds an
 * explicit field list that never included it, so it was a boolean that looked
 * meaningful and reached no agent; the attachments array is the real signal.
 *
 * A download that cannot happen must SAY so. WhatsApp declares `fileLength` on
 * every media node, so an over-size file is refused before a byte is fetched
 * and the refusal names the ceiling.
 */

import { describe, expect, test } from 'bun:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import { MAX_ATTACHMENT_BYTES } from '@metro-labs/mcp/stations/attachments';
import { startInbound } from '../src/inbound.ts';
import type { InboundHandlers, WAClient } from '../src/client.ts';
import { toInbound } from '../src/parse.ts';

type Ev = Record<string, unknown>;
type Payload = Record<string, unknown>;

const payloadOf = (e: Ev): Payload => e.payload as Payload;

async function run(message: unknown, id = 'MID'): Promise<Ev[]> {
  const lines: Ev[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line) as Ev);
    }
    return true;
  }) as typeof process.stdout.write;
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let handlers: InboundHandlers | undefined;
  const client = {
    start(h: InboundHandlers) {
      handlers = h;
      return Promise.resolve();
    },
    reuploadMedia(m: WAMessage) {
      return Promise.resolve(m);
    },
  } as unknown as WAClient;
  try {
    await startInbound(client);
    const raw = {
      key: { remoteJid: '111@s.whatsapp.net', id, fromMe: false },
      message,
      messageTimestamp: 1_700_000_000,
      pushName: 'Client Counsel',
    } as unknown as WAMessage;
    const m = toInbound('w0', raw);
    if (!m) throw new Error('toInbound dropped the message');
    handlers?.onMessage(m, raw);
    for (let i = 0; i < 40 && lines.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    process.stdout.write = realWrite;
    process.stderr.write = realErr;
  }
  return lines;
}

const OVERSIZE = {
  documentMessage: {
    mimetype: 'application/pdf',
    fileName: 'q3-archive.zip',
    caption: 'the whole quarter is in here',
    fileLength: MAX_ATTACHMENT_BYTES + 1,
    url: 'https://mmg.whatsapp.net/v/never-fetched',
    directPath: '/v/never-fetched',
    mediaKey: new Uint8Array(32),
  },
};

describe('inbound media envelope', () => {
  test('a text message carries no attachments and no has_media', async () => {
    const [env] = await run({ conversation: 'just text' }, 'TXT1');
    expect(env?.text).toBe('just text');
    expect(env?.has_media).toBeUndefined();
    expect(payloadOf(env as Ev).attachments).toBeUndefined();
  });

  test('media rides on payload.attachments with the caption intact', async () => {
    const [env] = await run(OVERSIZE, 'DOC1');
    expect(env?.text).toBe(
      'the whole quarter is in here [document: q3-archive.zip]',
    );
    expect(env?.has_media).toBeUndefined();
    expect(payloadOf(env as Ev).attachments).toEqual([
      {
        kind: 'document',
        name: 'q3-archive.zip',
        mime: 'application/pdf',
        size: MAX_ATTACHMENT_BYTES + 1,
      },
    ]);
  });
});

describe('a download that cannot happen is reported, not dropped', () => {
  test('an over-size file is refused before a byte is fetched', async () => {
    const events = await run(OVERSIZE, 'BIG1');
    expect(events).toHaveLength(2);
    const [env, failed] = events;
    const p = payloadOf(failed as Ev);
    expect(p.contentType).toBe('attachmentFailed');
    expect(p.attachmentFor).toBe(env?.id);
    expect(p.kind).toBe('document');
    expect(p.name).toBe('q3-archive.zip');
    expect(p.index).toBe(0);
    expect(String(p.reason)).toBe(
      `attachment size ${MAX_ATTACHMENT_BYTES + 1} exceeds limit of ${MAX_ATTACHMENT_BYTES} bytes`,
    );
  });

  test('the failure event names the same line as the message it belongs to', async () => {
    const [env, failed] = await run(OVERSIZE, 'BIG2');
    expect(failed?.line).toBe(env?.line);
    expect(failed?.station).toBe('whatsapp');
    expect(failed?.kind).toBe('inbound');
  });
});
