import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FileLocation } from '@mtcute/bun';
import {
  downloadMedia,
  isDownloadable,
  pendingDescriptorOf,
  type DownloadableMedia,
} from '../src/attachments.js';
import type { UserClient } from '../src/client.js';

const asMedia = (over: Record<string, unknown>): DownloadableMedia => {
  const media = { ...over };
  Object.setPrototypeOf(media, FileLocation.prototype);
  return media as unknown as DownloadableMedia;
};

describe('isDownloadable', () => {
  test('true for FileLocation-backed media', () => {
    expect(isDownloadable(asMedia({ type: 'voice' }))).toBe(true);
  });

  test('false for non-file media (e.g. location)', () => {
    const location = { type: 'location' } as unknown as DownloadableMedia;
    expect(isDownloadable(location)).toBe(false);
  });
});

describe('pendingDescriptorOf', () => {
  test('voice → audio kind', () => {
    expect(pendingDescriptorOf(asMedia({ type: 'voice', mimeType: 'audio/ogg' }))).toEqual({
      kind: 'audio',
    });
  });

  test('photo → image kind', () => {
    expect(pendingDescriptorOf(asMedia({ type: 'photo' }))).toEqual({
      kind: 'image',
    });
  });

  test('document keeps its file name', () => {
    expect(
      pendingDescriptorOf(
        asMedia({ type: 'document', mimeType: 'application/pdf', fileName: 'report.pdf' }),
      ),
    ).toEqual({ kind: 'file', name: 'report.pdf' });
  });
});

describe('downloadMedia', () => {
  let dir: string;
  let prev: string | undefined;

  beforeAll(() => {
    prev = process.env.METRO_XMTP_ATTACH_DIR;
    dir = mkdtempSync(join(tmpdir(), 'tg-user-att-'));
    process.env.METRO_XMTP_ATTACH_DIR = dir;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.METRO_XMTP_ATTACH_DIR;
    else process.env.METRO_XMTP_ATTACH_DIR = prev;
  });

  test('downloads bytes via mtcute and saves to the cache', async () => {
    let received: unknown;
    const client = {
      account: { id: 'default' },
      tg: {
        downloadAsBuffer: async (media: unknown): Promise<Uint8Array> => {
          received = media;
          return new Uint8Array([1, 2, 3, 4]);
        },
      },
    } as unknown as UserClient;
    const media = asMedia({ type: 'voice', mimeType: 'audio/ogg' });
    const saved = await downloadMedia(client, media, '42', 0);
    expect(received).toBe(media);
    expect(saved.bytes).toBe(4);
    expect(saved.mime).toBe('audio/ogg');
    expect(saved.path.startsWith(dir)).toBe(true);
    expect(saved.path.endsWith('.ogg')).toBe(true);
  });
});
