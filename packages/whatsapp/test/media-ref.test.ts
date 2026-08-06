/**
 * WhatsApp inbound media descriptors.
 *
 * Before this, `parse.ts` had a `MEDIA_TAGS` table that turned each of the five
 * media nodes into a placeholder string (`[image]`, `[document]`, …) and a
 * `hasMedia` boolean. Nothing else happened: no `downloadMediaMessage` call
 * existed anywhere in the workspace, so a contract sent to Lisa arrived as the
 * literal text `[document]` with no file behind it.
 *
 * Two things are pinned here.
 *
 * 1. Every media node yields a descriptor with the kind, the mime, the sender's
 *    filename and the DECLARED byte length. The length is what lets the station
 *    refuse an over-size file before a byte moves, and WhatsApp encodes it as a
 *    protobuf 64-bit int, which arrives as a `Long`-like object rather than a
 *    number.
 * 2. A voice note is not an audio file. WhatsApp ships both as `audioMessage`
 *    and distinguishes them ONLY by the `ptt` flag, which was never read, so a
 *    push-to-talk recording and an mp3 both projected as `[audio]`.
 */

import { describe, expect, test } from 'bun:test';
import type { WAMessage } from 'baileys';
import { mediaRefOf, toInbound } from '../src/parse.ts';

const asMessage = (m: unknown): WAMessage => m as WAMessage;

const inbound = (message: unknown, id = 'MID'): ReturnType<typeof toInbound> =>
  toInbound(
    'w0',
    asMessage({
      key: { remoteJid: '111@s.whatsapp.net', id, fromMe: false },
      message,
      messageTimestamp: 1_700_000_000,
    }),
  );

describe('mediaRefOf', () => {
  test('image carries kind, mime and declared size', () => {
    expect(
      mediaRefOf({
        imageMessage: { mimetype: 'image/jpeg', fileLength: 19_051 },
      }),
    ).toEqual({
      kind: 'image',
      mime: 'image/jpeg',
      name: 'image.jpg',
      bytes: 19_051,
    });
  });

  test('document keeps the name the sender chose', () => {
    expect(
      mediaRefOf({
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'nda-2026.pdf',
          fileLength: 91_244,
        },
      }),
    ).toEqual({
      kind: 'document',
      mime: 'application/pdf',
      name: 'nda-2026.pdf',
      bytes: 91_244,
    });
  });

  test('video and sticker resolve their own kinds', () => {
    expect(mediaRefOf({ videoMessage: { mimetype: 'video/mp4' } })?.kind).toBe(
      'video',
    );
    expect(
      mediaRefOf({ stickerMessage: { mimetype: 'image/webp' } })?.kind,
    ).toBe('sticker');
  });

  test('a push-to-talk recording is a voice note, an mp3 is not', () => {
    const ptt = mediaRefOf({
      audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
    });
    const file = mediaRefOf({
      audioMessage: { mimetype: 'audio/mpeg', ptt: false },
    });
    expect(ptt?.kind).toBe('voice');
    expect(ptt?.name).toBe('voice-message.ogg');
    expect(file?.kind).toBe('audio');
    expect(file?.name).toBe('audio.mp3');
  });

  test('a missing ptt flag is an audio file, not a voice note', () => {
    expect(mediaRefOf({ audioMessage: { mimetype: 'audio/mpeg' } })?.kind).toBe(
      'audio',
    );
  });

  test('mime parameters are stripped so the cached file gets a real extension', () => {
    expect(
      mediaRefOf({ audioMessage: { mimetype: 'audio/ogg; codecs=opus' } })?.mime,
    ).toBe('audio/ogg');
  });

  test('a protobuf Long fileLength becomes a number', () => {
    expect(
      mediaRefOf({
        documentMessage: {
          mimetype: 'application/pdf',
          fileLength: { toNumber: () => 943_718_400 },
        },
      })?.bytes,
    ).toBe(943_718_400);
  });

  test('an absent fileLength leaves bytes unset rather than zero', () => {
    const ref = mediaRefOf({ imageMessage: { mimetype: 'image/jpeg' } });
    expect(ref?.bytes).toBeUndefined();
    expect('bytes' in (ref ?? {})).toBe(false);
  });

  test('a document wrapped in documentWithCaption still resolves', () => {
    expect(
      mediaRefOf({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: 'application/pdf',
              fileName: 'wrapped.pdf',
              caption: 'sign here',
            },
          },
        },
      }),
    ).toMatchObject({ kind: 'document', name: 'wrapped.pdf' });
  });

  test('a view-once image still resolves', () => {
    expect(
      mediaRefOf({
        viewOnceMessageV2: {
          message: { imageMessage: { mimetype: 'image/jpeg' } },
        },
      })?.kind,
    ).toBe('image');
  });

  test('text-only messages have no descriptor', () => {
    expect(mediaRefOf({ conversation: 'hi' })).toBeUndefined();
  });
});

describe('projected text', () => {
  test('a caption survives alongside the media tag', () => {
    expect(
      inbound({
        imageMessage: { mimetype: 'image/jpeg', caption: 'the caption' },
      })?.text,
    ).toBe('the caption [image]');
  });

  test('a document caption survives and the tag names the file', () => {
    expect(
      inbound({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: 'application/pdf',
              fileName: 'nda-2026.pdf',
              caption: 'Please review clause 2 before Friday',
            },
          },
        },
      })?.text,
    ).toBe('Please review clause 2 before Friday [document: nda-2026.pdf]');
  });

  test('a voice note reads as a voice note, an mp3 as audio', () => {
    expect(
      inbound({
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
      })?.text,
    ).toBe('[voice]');
    expect(inbound({ audioMessage: { mimetype: 'audio/mpeg' } })?.text).toBe(
      '[audio]',
    );
  });

  test('the descriptor rides on the inbound message', () => {
    expect(
      inbound({
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'x.pdf',
          fileLength: 10,
        },
      })?.media,
    ).toEqual({
      kind: 'document',
      mime: 'application/pdf',
      name: 'x.pdf',
      bytes: 10,
    });
  });
});
