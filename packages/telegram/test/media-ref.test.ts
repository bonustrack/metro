/**
 * The Bot API hands us `mime_type` on documents, audio, video and animations,
 * and metro dropped it on the floor for everything except photos, voice and
 * video. An inbound pdf therefore reached the agent with an empty `mime`, and
 * the cached copy was named `.bin` whenever the sender's file had no
 * extension in its name either.
 */

import { describe, expect, test } from 'bun:test';
import { mediaRefOf } from '../src/attachments.ts';
import type { TgMsg } from '../src/types.ts';

const msg = (media: Partial<TgMsg>): TgMsg =>
  ({
    message_id: 1569,
    date: 1_785_954_000,
    chat: { id: 25220238, type: 'private' },
    ...media,
  }) as TgMsg;

describe('telegram media refs carry the mime the Bot API supplied', () => {
  test('a document keeps its mime_type', () => {
    const ref = mediaRefOf(
      msg({
        document: {
          file_id: 'BQACAgQ',
          file_name: '1322992.pdf',
          mime_type: 'application/pdf',
        },
      }),
    );
    expect(ref).toEqual({
      fileId: 'BQACAgQ',
      name: '1322992.pdf',
      mime: 'application/pdf',
    });
  });

  test('an audio file keeps its mime_type', () => {
    const ref = mediaRefOf(
      msg({
        audio: {
          file_id: 'CQACAgQ',
          file_name: 'Call +6622028585_260803_121819.m4a',
          mime_type: 'audio/mp4',
        },
      }),
    );
    expect(ref?.mime).toBe('audio/mp4');
  });

  test('an animation keeps its mime_type', () => {
    const ref = mediaRefOf(
      msg({
        animation: { file_id: 'CgACAgQ', file_name: 'cat.gif', mime_type: 'video/mp4' },
      }),
    );
    expect(ref?.mime).toBe('video/mp4');
  });

  test('a video prefers the reported mime over the video/mp4 default', () => {
    expect(
      mediaRefOf(msg({ video: { file_id: 'v1', mime_type: 'video/quicktime' } }))
        ?.mime,
    ).toBe('video/quicktime');
    expect(mediaRefOf(msg({ video: { file_id: 'v2' } }))?.mime).toBe('video/mp4');
  });

  test('a voice note still falls back to audio/ogg', () => {
    expect(mediaRefOf(msg({ voice: { file_id: 'v3' } }))?.mime).toBe('audio/ogg');
  });

  test('a photo is unchanged and a message with no media has no ref', () => {
    expect(
      mediaRefOf(msg({ photo: [{ file_id: 'p1' }, { file_id: 'p2' }] })),
    ).toEqual({ fileId: 'p2', mime: 'image/jpeg' });
    expect(mediaRefOf(msg({ text: 'no media here' }))).toBeNull();
  });
});
