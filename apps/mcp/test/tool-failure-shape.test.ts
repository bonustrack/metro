import { describe, expect, test } from 'bun:test';
import { attachmentShape } from '../src/mcp/tool-dispatch.ts';

const PAYLOAD = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, 0x80,
]);
const B64 = PAYLOAD.toString('base64');

describe('the attachment shape a failed tool call is logged with', () => {
  test('is absent when the call named no attachments', () => {
    expect(attachmentShape({ line: 'metro://discord-bot/acc/chan' })).toBeUndefined();
    expect(attachmentShape({ attachments: 'nonsense' })).toBeUndefined();
  });

  test('names the source each attachment used', () => {
    expect(
      attachmentShape({
        attachments: [
          { path: '/srv/a.png' },
          { url: 'https://x.test/a.png' },
          { name: 'a.png', mime: 'image/png' },
        ],
      }),
    ).toEqual(['path', 'url', 'none']);
  });

  test('records an inline attachment by size, never by content', () => {
    const shape = attachmentShape({ attachments: [{ data: B64 }] });
    expect(shape).toEqual([`data(${PAYLOAD.length}B)`]);
    expect(shape?.join('')).not.toContain(B64);
  });

  test('names every source of an attachment that named several', () => {
    expect(
      attachmentShape({
        attachments: [{ path: '/srv/a.png', data: B64 }],
      }),
    ).toEqual([`path+data(${PAYLOAD.length}B)`]);
  });

  test('an empty-string source is not counted as a source', () => {
    expect(attachmentShape({ attachments: [{ path: '', url: '' }] })).toEqual([
      'none',
    ]);
  });
});
