import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { setTrainCallBackend } from '../src/daemon/train-call.ts';
import type { TrainCallResponse } from '../src/daemon/protocol.ts';
import { normalizeDiscord } from '../src/stations/messaging-normalize.ts';

const dir = mkdtempSync(join(tmpdir(), 'metro-honesty-'));
const png = join(dir, 'a.png');
const pdf = join(dir, 'b.pdf');
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(pdf, '%PDF-1.4');

interface StationCase {
  name: string;
  line: string;
  attachmentActions: string[];
}

const STATION_CASES: StationCase[] = [
  {
    name: 'telegram-bot',
    line: 'metro://telegram-bot/t0/-100123',
    attachmentActions: [],
  },
  {
    name: 'telegram',
    line: 'metro://telegram/default/12345',
    attachmentActions: [],
  },
  {
    name: 'discord-bot',
    line: 'metro://discord-bot/d0/1531084421833297970',
    attachmentActions: [],
  },
  {
    name: 'whatsapp',
    line: 'metro://whatsapp/w0/111@s.whatsapp.net',
    attachmentActions: [],
  },
  {
    name: 'xmtp',
    line: 'metro://xmtp/x0/0xabc',
    attachmentActions: ['sendImage', 'sendAttachment'],
  },
];

interface Call {
  train: string;
  action: string;
  args: Record<string, unknown>;
}

function stubTrain(
  reply: (call: Call) => TrainCallResponse,
): { calls: Call[] } {
  const calls: Call[] = [];
  setTrainCallBackend((train, action, args) => {
    const call = { train, action, args: args as Record<string, unknown> };
    calls.push(call);
    return Promise.resolve(reply(call));
  });
  return { calls };
}

const textOf = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

afterEach(() => {
  setTrainCallBackend(() => Promise.resolve({ result: null }));
});

describe('a station that silently drops an attachment errors, per station', () => {
  for (const c of STATION_CASES) {
    test(`${c.name}: a send that delivers nothing is an error, not a success`, async () => {
      stubTrain((call) =>
        c.attachmentActions.includes(call.action)
          ? { error: 'not sent' }
          : { result: { messageId: '1', account: 'a' } },
      );
      const res = await dispatchMessageTool('send', {
        line: c.line,
        text: 'hi',
        attachments: [{ path: png }],
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/delivered 0 of 1 attachment|not sent/);
    });

    test(`${c.name}: a send that delivers only some of them is an error`, async () => {
      let seen = 0;
      stubTrain((call) => {
        if (c.attachmentActions.includes(call.action)) {
          seen += 1;
          return seen > 1
            ? { error: 'second attachment refused' }
            : { result: { messageId: '1', account: 'a' } };
        }
        return {
          result: { messageId: '1', account: 'a', attachments: ['image'] },
        };
      });
      const res = await dispatchMessageTool('send', {
        line: c.line,
        attachments: [{ path: png }, { path: pdf }],
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(
        /delivered 1 of 2 attachment|second attachment refused/,
      );
    });

    test(`${c.name}: a send that delivers everything reports each label`, async () => {
      stubTrain((call) =>
        c.attachmentActions.includes(call.action)
          ? { result: { messageId: '1', account: 'a' } }
          : {
              result: {
                messageId: '1',
                account: 'a',
                attachments: ['image', 'file'],
              },
            },
      );
      const res = await dispatchMessageTool('send', {
        line: c.line,
        attachments: [{ path: png }, { path: pdf }],
      });
      expect(res.isError).toBeUndefined();
      expect(textOf(res)).toBe(
        c.attachmentActions.length > 0
          ? 'sent: image, file'
          : 'sent: image, file — message_id: 1',
      );
    });
  }
});

describe('the canonical wire carries what a station needs to label honestly', () => {
  test('the name survives resolution and travels next to the cache path', async () => {
    const { calls } = stubTrain(() => ({
      result: { messageId: '1', account: 'a', attachments: ['image'] },
    }));
    await dispatchMessageTool('send', {
      line: 'metro://discord-bot/d0/1531084421833297970',
      attachments: [{ path: png, name: 'horse.png' }],
    });
    const send = calls.find((c) => c.action === 'send');
    expect(send?.args.attachments).toEqual([
      {
        kind: 'image',
        path: png,
        url: png,
        name: 'horse.png',
        mime: 'image/png',
      },
    ]);
  });

  test('a url keeps its own filename rather than the internal cache name', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(Buffer.from([0x49, 0x44, 0x33, 0x04]), {
          headers: { 'content-type': 'audio/mpeg' },
        }),
    });
    const { calls } = stubTrain(() => ({
      result: { messageId: '1', account: 'a', attachments: ['audio'] },
    }));
    try {
      await dispatchMessageTool('send', {
        line: 'metro://discord-bot/d0/1531084421833297970',
        attachments: [{ url: `http://127.0.0.1:${server.port}/horse.mp3` }],
      });
    } finally {
      await server.stop(true);
    }
    const [wire] = (calls.find((c) => c.action === 'send')?.args
      .attachments ?? []) as { path: string; name: string }[];
    expect(wire?.name).toBe('horse.mp3');
    expect(wire?.path).toMatch(/msg_out[a-z0-9]+_0\.mp3$/);
    expect(wire?.path).not.toContain('horse.mp3');
  });
});

describe('normalizeDiscord hands the train a name per file', () => {
  test('files, kinds and names line up index for index', () => {
    const { args } = normalizeDiscord('send', {
      line: 'metro://discord-bot/d0/1',
      attachments: [
        { path: '/cache/msg_outaaa_0.mp3', kind: 'audio', name: 'horse.mp3' },
        { path: '/cache/msg_outbbb_0.png', kind: 'image', name: 'chart.png' },
      ],
    });
    expect(args.files).toEqual([
      '/cache/msg_outaaa_0.mp3',
      '/cache/msg_outbbb_0.png',
    ]);
    expect(args.attachmentKinds).toEqual(['audio', 'image']);
    expect(args.attachmentNames).toEqual(['horse.mp3', 'chart.png']);
  });

  test('a nameless attachment yields an empty name, so the station falls back', () => {
    const { args } = normalizeDiscord('send', {
      line: 'metro://discord-bot/d0/1',
      attachments: [{ path: '/cache/msg_outaaa_0.mp3', kind: 'audio' }],
    });
    expect(args.attachmentNames).toEqual(['']);
  });

  test('an attachment with no path and no url is dropped from every list', () => {
    const { args } = normalizeDiscord('send', {
      line: 'metro://discord-bot/d0/1',
      attachments: [
        { path: '/cache/msg_outaaa_0.mp3', kind: 'audio', name: 'horse.mp3' },
        { kind: 'image', name: 'ghost.png' },
      ],
    });
    expect(args.files).toEqual(['/cache/msg_outaaa_0.mp3']);
    expect(args.attachmentKinds).toEqual(['audio']);
    expect(args.attachmentNames).toEqual(['horse.mp3']);
  });
});
