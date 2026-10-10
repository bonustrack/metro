import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { ContentTypeFrame, ContentTypeFrameAction, FrameCodec, type FrameContent } from '../src/codecs.ts';
import { FRAME_MAX_CHARS, FRAME_MAX_SCREENS, buildFrameContent, frameSummary } from '../src/frames.ts';
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

describe('frame source', () => {
  const url = 'https://proxy.stage.box/nodes/btc-price';

  test('the node url goes with the frame, trimmed', () => {
    expect(buildFrameContent({ widget, source: { url: `  ${url}  ` } }).frame).toEqual({
      title: 'Weekly report', description: 'Sales up 12%', widget, source: { url },
    });
    expect(buildFrameContent(JSON.stringify({ widget, source: { url } })).frame.source).toEqual({ url });
  });

  test.each([
    ['a plain string', url],
    ['an object with no url', {}],
    ['an http url', { url: 'http://proxy.stage.box/nodes/btc-price' }],
    ['not a url', { url: 'https://' }],
  ])('refuses a source that is %s', (_, source) => {
    expect(() => buildFrameContent({ widget, source })).toThrow(/frame source must be/);
  });

  test('refuses a source url over 2048 characters', () => {
    expect(() => buildFrameContent({ widget, source: { url: `${url}?q=${'x'.repeat(2048)}` } })).toThrow(/limit is 2048/);
  });
});

describe('frames with screens', () => {
  const open = (screen: string) => ({ type: 'frame.open', payload: { screen } });
  const home = { type: 'ListView', children: [{ type: 'ListViewItem', onClickAction: open('s1'), children: [{ type: 'Text', value: 'Story one' }] }] };
  const story = { type: 'Card', children: [{ type: 'Title', value: 'Story one' }, { type: 'Button', label: 'Back', onClickAction: { type: 'frame.back' } }] };

  test('screens go as they are, and the summary comes from the start screen', () => {
    const screens = { home, s1: { title: ' Story ', widget: story } };
    expect(buildFrameContent({ title: 'HN', screens, start: 'home' })).toEqual({
      frame: { title: 'HN', screens: { home, s1: { title: 'Story', widget: story } }, start: 'home' },
      title: 'HN',
    });
    expect(buildFrameContent({ screens, start: 's1' }).frame).toEqual({
      title: 'Story one', screens: { home, s1: { title: 'Story', widget: story } }, start: 's1',
    });
    expect(buildFrameContent(JSON.stringify({ screens: JSON.stringify({ home, s1: story }), start: 'home' })).frame.screens).toEqual({ home, s1: story });
  });

  test.each([
    ['both a widget and screens', { widget: story, screens: { home } }, /not both/],
    ['no screens', { screens: {} }, /1 to 50 screens/],
    ['too many screens', { screens: Object.fromEntries(Array.from({ length: FRAME_MAX_SCREENS + 1 }, (_, i) => [`s${i}`, story])) }, /not 51/],
    ['an empty id', { screens: { '': story } }, /screen ids/],
    ['a screen that is not a widget', { screens: { home, s1: { children: [] } } }, /frame screen "s1" must be/],
    ['a titled screen without a widget type', { screens: { home: { title: 'x', widget: {} } } }, /frame screen "home" widget must be/],
    ['no start', { screens: { home, s1: story } }, /start is required with screens/],
    ['an unknown start', { screens: { home, s1: story }, start: 'nope' }, /start is required with screens/],
    ['a frame.open to no screen', { screens: { home }, start: 'home' }, /frame.open goes to screen "s1"/],
    ['screens not an object', { screens: [home] }, /frame screens must be an object/],
  ])('refuses %s', (_, frame, message) => {
    expect(() => buildFrameContent(frame)).toThrow(message);
  });

  test('the size limit holds over all the screens', () => {
    const half = { type: 'Card', children: [{ type: 'Text', value: 'x'.repeat(FRAME_MAX_CHARS / 2) }] };
    expect(() => buildFrameContent({ screens: { a: half, b: half }, start: 'a' })).toThrow(/frame screens is \d+ characters; the limit is 65536/);
  });

  test('a frame with screens reads as its title', () => {
    expect(typedEnvelope(base, 'frame', { title: 'HN', screens: { home } }, ctx)?.text).toBe('Frame: HN');
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

  test('sends the node source with the frame', async () => {
    const source = { url: 'https://proxy.stage.box/nodes/btc-price' };
    expect((await call({ frame: { widget, title: 'Report', source } })).result).toEqual({ messageId: 'frame-msg-id' });
    expect(sent).toEqual([new FrameCodec().encode({ title: 'Report', description: 'Sales up 12%', widget, source })]);
  });

  test('a bad frame sends nothing, not even the text', async () => {
    expect((await call({ text: 'Here it is', frame: { widget: { children: [] } } })).error).toMatch(/frame widget must be/);
    expect(sent).toEqual([]);
  });
});
