import { describe, expect, test } from 'bun:test';
import { xmtpSendAttachments } from '../src/tools.ts';
import type { ToolContext } from '@metro-labs/mcp/stations/types';

interface Sent {
  action: string;
  args: Record<string, unknown>;
}

function fakeCtx(sent: Sent[]): ToolContext {
  return {
    call: (action, args) => {
      sent.push({ action, args });
      return Promise.resolve({ result: null });
    },
    ok: (text) => ({ content: [{ type: 'text', text }] }),
    okJson: (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] }),
    err: (text) => ({ content: [{ type: 'text', text }], isError: true }),
    readFile: () => Promise.resolve(Buffer.from([0x49, 0x44, 0x33, 0x04])),
  };
}

const LINE = 'metro://xmtp/x0/0xabc';

describe('xmtpSendAttachments labels what it sent', () => {
  test('an mp3 is labelled audio, not file', async () => {
    const sent: Sent[] = [];
    const labels = await xmtpSendAttachments(
      LINE,
      [{ path: '/cache/song.mp3', mime: 'audio/mpeg', name: 'song.mp3' }],
      fakeCtx(sent),
    );
    expect(sent.map((s) => s.action)).toEqual(['sendAttachment']);
    expect(labels).toEqual(['audio']);
  });

  test('an mp4 is labelled video and a pdf stays file', async () => {
    const sent: Sent[] = [];
    const labels = await xmtpSendAttachments(
      LINE,
      [
        { path: '/cache/clip.mp4', mime: 'video/mp4' },
        { path: '/cache/doc.pdf', mime: 'application/pdf' },
      ],
      fakeCtx(sent),
    );
    expect(labels).toEqual(['video', 'file']);
  });

  test('an image still goes through sendImage and is labelled image', async () => {
    const sent: Sent[] = [];
    const labels = await xmtpSendAttachments(
      LINE,
      [{ path: '/cache/a.png', mime: 'image/png' }],
      fakeCtx(sent),
    );
    expect(sent.map((s) => s.action)).toEqual(['sendImage']);
    expect(labels).toEqual(['image']);
  });

  test('one label per attachment it actually pushed', async () => {
    const sent: Sent[] = [];
    const labels = await xmtpSendAttachments(
      LINE,
      [{ path: '/cache/a.png', mime: 'image/png' }, { mime: 'image/png' }],
      fakeCtx(sent),
    );
    expect(sent).toHaveLength(1);
    expect(labels).toEqual(['image']);
  });
});
