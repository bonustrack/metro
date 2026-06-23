import { describe, expect, test } from 'bun:test';
import { mergeAppData } from '../src/labels.ts';
import { setChannelMetadata } from '../src/tools-handlers.ts';
import type { ToolContext } from '@metro-labs/station-kit/types';

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
