import { describe, expect, test } from 'bun:test';
import { mergeAppData } from '../src/labels.ts';
import { setChannelMetadata } from '../src/tools-handlers.ts';
import type { ToolContext } from '@metro-labs/core/stations/types';

function sequentialMerge(
  start: string | undefined,
  patches: Record<string, unknown>[],
): Record<string, unknown> {
  let blob = start;
  let merged: Record<string, unknown> = {};
  for (const patch of patches) {
    const res = mergeAppData(blob, patch);
    blob = res.blob;
    merged = res.merged;
  }
  return merged;
}

describe('atomic appData merge equivalence', () => {
  test('one patch equals sequential labels/github/preview patches', () => {
    const start = JSON.stringify({ v: 1, labels: ['old'] });
    const github = 'https://github.com/foo/bar';
    const preview = 'https://example.com/p';
    const sequential = sequentialMerge(start, [
      { labels: ['🎯 To-do'] },
      { github },
      { preview },
    ]);
    const atomic = mergeAppData(start, {
      labels: ['🎯 To-do'],
      github,
      preview,
    }).merged;
    expect(atomic).toEqual(sequential);
  });

  test('empty patch keys preserve existing data', () => {
    const start = JSON.stringify({ v: 1, labels: ['x'], github: 'https://github.com/a/b' });
    const atomic = mergeAppData(start, { labels: ['y'] }).merged;
    expect(atomic.github).toBe('https://github.com/a/b');
    expect(atomic.labels).toEqual(['y']);
  });
});

function fakeCtx(): { ctx: ToolContext; calls: { action: string; args: unknown }[] } {
  const calls: { action: string; args: unknown }[] = [];
  const ctx = {
    call: async (action: string, args: unknown) => {
      calls.push({ action, args });
      return { ok: true };
    },
    okJson: (v: unknown) => ({ json: v }),
    err: (m: string) => ({ error: m }),
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe('set_channel_metadata routes through one updateChannelMeta call', () => {
  test('labels + github + preview + name → single call', async () => {
    const { ctx, calls } = fakeCtx();
    await setChannelMetadata(
      {
        line: 'metro://xmtp/tony/g1',
        labels: ['🎯 To-do'],
        github: 'https://github.com/a/b',
        preview: 'https://x.y/z',
        name: 'feat: thing',
      },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('updateChannelMeta');
    expect(calls[0].args).toEqual({
      line: 'metro://xmtp/tony/g1',
      appData: {
        labels: ['🎯 To-do'],
        github: 'https://github.com/a/b',
        preview: 'https://x.y/z',
      },
      name: 'feat: thing',
    });
  });

  test('metadata patch and native fields use one call', async () => {
    const { ctx, calls } = fakeCtx();
    const metadata = { labels: ['In progress'], assigned: ['0x' + 'a'.repeat(40)], custom: { open: true } };
    await setChannelMetadata({ line: 'metro://xmtp/tony/g1', metadata, name: 'feat: thing' }, ctx);
    expect(calls).toEqual([{ action: 'updateChannelMeta', args: {
      line: 'metro://xmtp/tony/g1', appData: metadata, name: 'feat: thing',
    } }]);
  });

  test('assigned-only metadata and empty assigned list are forwarded', async () => {
    for (const assigned of [['0x' + 'a'.repeat(40)], []]) {
      const { ctx, calls } = fakeCtx();
      await setChannelMetadata({ line: 'metro://xmtp/tony/g1', metadata: { assigned } }, ctx);
      expect(calls).toEqual([{ action: 'updateChannelMeta', args: {
        line: 'metro://xmtp/tony/g1', appData: { assigned },
      } }]);
    }
  });

  test('invalid native names never dispatch otherwise valid metadata', async () => {
    const { ctx, calls } = fakeCtx();
    const result = await setChannelMetadata({ line: 'metro://xmtp/tony/g1', name: 42, metadata: { assigned: [] } }, ctx);
    expect(result).toEqual({ error: 'set_channel_metadata name must be a string' });
    expect(calls).toHaveLength(0);
  });

  test('duplicate legacy and metadata fields are refused', async () => {
    const { ctx, calls } = fakeCtx();
    await expect(setChannelMetadata({
      line: 'metro://xmtp/tony/g1', labels: ['old'], metadata: { labels: ['new'] },
    }, ctx)).rejects.toThrow('Specify labels only once, inside metadata or at the top level');
    expect(calls).toHaveLength(0);
  });

  test.each([null, [], 'text', { v: 2 }, { assigned: ['worker-id'] }, { labels: [4] }, { github: 'https://example.com' }])(
    'invalid metadata never dispatches: %j', async (metadata) => {
      const { ctx, calls } = fakeCtx();
      await expect(setChannelMetadata({ line: 'metro://xmtp/tony/g1', metadata }, ctx)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    },
  );

  test('no fields → error, no call', async () => {
    const { ctx, calls } = fakeCtx();
    const res = (await setChannelMetadata(
      { line: 'metro://xmtp/tony/g1' },
      ctx,
    )) as { error?: string };
    expect(res.error).toContain('at least one of');
    expect(calls).toHaveLength(0);
  });
});
