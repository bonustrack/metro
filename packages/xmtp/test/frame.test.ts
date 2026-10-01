import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { ContentTypeFrame, ContentTypeFrameAction, FrameCodec, type FrameContent } from '../src/codecs.ts';
import { FRAME_MAX_CHARS, buildFrameContent, frameSummary } from '../src/frames.ts';
import { typedEnvelope } from '../src/emit-payloads.ts';

const accountId = 'frame-test';
const line = `metro://xmtp/${accountId}/group1`;
const ctx = { accountId, msgId: 'm', line, baseId: 'b' };
const base = { id: 'b', line };

const widget = {
  type: 'Card',
  children: [
    { type: 'Row', children: [{ type: 'Title', value: 'Weekly **report**' }] },
    { type: 'Text', value: 'Sales up 12%' },
    { type: 'Button', label: 'Approve', onClickAction: { type: 'report.approve', payload: { week: 39 } } },
  ],
};

describe('frame content', () => {
  test('codec ids live under stage.box and round-trip', () => {
    expect(ContentTypeFrame).toEqual({ authorityId: 'stage.box', typeId: 'frame', versionMajor: 1, versionMinor: 0 });
    expect(ContentTypeFrameAction.typeId).toBe('frameAction');
    const codec = new FrameCodec();
    const frame: FrameContent = { title: 'Report', widget };
    const encoded = codec.encode(frame);
    expect(encoded.fallback).toBe('Frame: Report');
    expect(codec.decode(encoded)).toEqual(frame);
  });

  test('title and description come from the widget when missing', () => {
    expect(frameSummary(widget)).toEqual({ title: 'Weekly report', description: 'Sales up 12%' });
    expect(buildFrameContent({ widget })).toEqual({
      frame: { title: 'Weekly report', description: 'Sales up 12%', widget },
      title: 'Weekly report',
    });
  });

  test('explicit title and description win, are trimmed and cut', () => {
    const { frame } = buildFrameContent({ widget, title: '  Report  ', description: 'd'.repeat(1500) });
    expect(frame.title).toBe('Report');
    expect(frame.description).toHaveLength(1000);
  });

  test('a widget or a whole frame given as a JSON string is parsed', () => {
    expect(buildFrameContent({ widget: JSON.stringify(widget) }).frame.widget).toEqual(widget);
    expect(buildFrameContent(JSON.stringify({ widget, title: 'Report' })).frame).toMatchObject({ title: 'Report', widget });
  });

  test('refuses a frame that is not an object', () => {
    expect(() => buildFrameContent(['x'])).toThrow(/frame must be an object/);
  });

  test('a frame with no text has no title and reads as Frame', () => {
    expect(buildFrameContent({ widget: { type: 'Card', children: [] } })).toEqual({ frame: { widget: { type: 'Card', children: [] } }, title: 'Frame' });
  });

  test.each([
    ['no type', { children: [] }],
    ['an array', [widget]],
    ['bad JSON', '{"type":'],
  ])('refuses a widget with %s', (_, bad) => {
    expect(() => buildFrameContent({ widget: bad })).toThrow(/frame widget/);
  });

  test('refuses a widget over the size limit', () => {
    const big = { type: 'Card', children: [{ type: 'Text', value: 'x'.repeat(FRAME_MAX_CHARS) }] };
    expect(() => buildFrameContent({ widget: big })).toThrow(/limit is 65536/);
  });
});

describe('frame envelopes', () => {
  test('a frame action reads as a reply to the frame with its payload', () => {
    const out = typedEnvelope(base, 'frameAction', {
      frameId: 'frame-1', action: { type: 'report.approve', payload: { week: 39, note: 'ok' } }, label: 'Approve',
    }, ctx);
    expect(out).toEqual({
      ...base,
      text: 'Frame action: report.approve {"week":39,"note":"ok"} (tapped "Approve")',
      event: { type: 'reply', replyTo: 'frame-1' },
      payload: {
        contentType: 'frameAction',
        frameAction: { frameId: 'frame-1', action: { type: 'report.approve', payload: { week: 39, note: 'ok' } }, label: 'Approve' },
        replyTo: 'frame-1',
      },
    });
  });

  test('a malformed frame action falls through', () => {
    expect(typedEnvelope(base, 'frameAction', { action: 'x' }, ctx)).toBeUndefined();
  });

  test('a frame reads as its title', () => {
    expect(typedEnvelope(base, 'frame', { title: 'Report', description: 'Week 39', widget }, ctx)?.text).toBe('Frame: Report\nWeek 39');
  });
});

describe('send with a frame', () => {
  let out: string[] = [];
  let sent: unknown[] = [];
  let restore = (): void => {};

  beforeEach(() => {
    out = [];
    sent = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    restore = () => spy.mockRestore();
    const group = {
      id: 'group1',
      sendText: async (text: string) => { sent.push(text); return 'text-msg-id'; },
      send: async (content: unknown) => { sent.push(content); return 'frame-msg-id'; },
    };
    const client = { inboxId: 'self', conversations: { getConversationById: async () => group } };
    accounts.set(accountId, { cfg: { id: accountId }, client, inboxId: 'self' } as unknown as Account);
  });
  afterEach(() => {
    restore();
    accounts.delete(accountId);
  });

  const call = async (args: Record<string, unknown>): Promise<{ result?: unknown; error?: string }> => {
    await handleCall({ op: 'call', id: 'f', action: 'send', args: { line, ...args } });
    return out.map((l) => JSON.parse(l) as { op: string; result?: unknown; error?: string }).find((e) => e.op === 'response') ?? {};
  };

  test('sends the frame content type and answers with its id', async () => {
    expect((await call({ frame: { widget, title: 'Report' } })).result).toEqual({ messageId: 'frame-msg-id' });
    expect(sent).toEqual([new FrameCodec().encode({ title: 'Report', description: 'Sales up 12%', widget })]);
  });

  test('sends the text first, then the frame, and answers with the frame id', async () => {
    expect((await call({ text: 'Here it is', frame: { widget } })).result).toEqual({ messageId: 'frame-msg-id' });
    expect(sent).toEqual(['Here it is', new FrameCodec().encode({ title: 'Weekly report', description: 'Sales up 12%', widget })]);
  });

  test('a bad frame sends nothing, not even the text', async () => {
    expect((await call({ text: 'Here it is', frame: { widget: { children: [] } } })).error).toMatch(/frame widget must be/);
    expect(sent).toEqual([]);
  });
});
