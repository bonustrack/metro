import { describe, expect, test } from 'bun:test';
import { buildInputMedia, sendAttachments } from '../src/media-actions.js';
import type { UserClient } from '../src/client.js';

describe('buildInputMedia', () => {
  test('image mime → photo input media with caption + fileName', () => {
    const { media: m } = buildInputMedia(
      { path: '/cache/a.jpg', mime: 'image/jpeg', name: 'a.jpg' },
      'a caption',
    );
    expect(m.type).toBe('photo');
    expect(m.file).toBe('file:/cache/a.jpg');
    expect(m.caption).toBe('a caption');
    expect(m.fileName).toBe('a.jpg');
  });

  test('a local path is prefixed with file: so mtcute does not read it as a file id', () => {
    const { media: m } = buildInputMedia({ path: '/data/x/audit.png' }, undefined);
    expect(m.file).toBe('file:/data/x/audit.png');
  });

  test('an http url is passed through untouched for telegram to fetch', () => {
    const { media: m } = buildInputMedia(
      { url: 'https://example.com/a.png', mime: 'image/png' },
      undefined,
    );
    expect(m.file).toBe('https://example.com/a.png');
  });

  test('an already-prefixed file: path is not double-prefixed', () => {
    const { media: m } = buildInputMedia({ path: 'file:/cache/a.png' }, undefined);
    expect(m.file).toBe('file:/cache/a.png');
  });

  test('image kind without mime → photo', () => {
    const { media: m } = buildInputMedia({ url: '/cache/b', kind: 'image' }, undefined);
    expect(m.type).toBe('photo');
    expect(m.caption).toBeUndefined();
  });

  test('image by extension → photo', () => {
    const { media: m } = buildInputMedia({ url: '/cache/c.png' }, undefined);
    expect(m.type).toBe('photo');
  });

  test('non-image → document', () => {
    const { media: m } = buildInputMedia(
      { path: '/cache/d.pdf', mime: 'application/pdf', name: 'd.pdf' },
      undefined,
    );
    expect(m.type).toBe('document');
    expect(m.file).toBe('file:/cache/d.pdf');
    expect(m.fileName).toBe('d.pdf');
  });
});

function mediaClient(sent: unknown[]): UserClient {
  const tg = {
    resolvePeer: (chatId: number): Promise<unknown> =>
      Promise.resolve({ peer: chatId }),
    sendMedia: (...args: unknown[]): Promise<{ id: number }> => {
      sent.push(args[1]);
      return Promise.resolve({ id: 100 + sent.length });
    },
  };
  return { account: { id: 'default', session: 's' }, tg } as unknown as UserClient;
}

describe('sendAttachments reports what it pushed', () => {
  test('one label per attachment actually handed to sendMedia', async () => {
    const sent: unknown[] = [];
    const out = await sendAttachments(
      { client: mediaClient(sent), chatId: 1 },
      [
        { path: '/cache/a.jpg', mime: 'image/jpeg' },
        { path: '/cache/b.pdf', mime: 'application/pdf' },
      ],
      'cap',
    );
    expect(sent).toHaveLength(2);
    expect(out.delivered).toEqual(['image', 'file']);
  });

  test('an attachment the loop skips is NOT reported as delivered', async () => {
    const sent: unknown[] = [];
    const out = await sendAttachments(
      { client: mediaClient(sent), chatId: 1 },
      [{ path: '/cache/a.jpg', mime: 'image/jpeg' }, { mime: 'image/png' }],
      '',
    );
    expect(sent).toHaveLength(1);
    expect(out.delivered).toEqual(['image']);
  });

  test('the label names the media type mtcute was actually given', async () => {
    const sent: unknown[] = [];
    const out = await sendAttachments(
      { client: mediaClient(sent), chatId: 1 },
      [{ path: '/cache/song.mp3', mime: 'audio/mpeg' }],
      '',
    );
    expect((sent[0] as { type: string }).type).toBe('document');
    expect(out.delivered).toEqual(['file']);
  });
});
