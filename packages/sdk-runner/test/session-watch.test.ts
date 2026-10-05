import { describe, expect, test } from 'bun:test';
import { SessionWatch } from '../src/session-watch.ts';

const stream = (event: Record<string, unknown>, parent: string | null = null): Record<string, unknown> => ({ type: 'stream_event', parent_tool_use_id: parent, event });
const start = (usage: Record<string, unknown>): Record<string, unknown> => stream({ type: 'message_start', message: { usage } });
const delta = (usage: Record<string, unknown>): Record<string, unknown> => stream({ type: 'message_delta', usage });

describe('main context usage', () => {
  test('counts Codex usage delivered after the SDK assistant message', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(start({ input_tokens: 0, output_tokens: 0 }));
    watch.observe({ type: 'assistant', parent_tool_use_id: null, message: { usage: { input_tokens: 0, output_tokens: 0 } } });
    expect(watch.context).toBe(0);
    watch.observe(delta({ input_tokens: 14_565, cache_read_input_tokens: 10_000, output_tokens: 7 }));
    expect(watch.context).toBe(24_565);
    watch.observe({ type: 'result', usage: { input_tokens: 80_000 }, modelUsage: { codex: { inputTokens: 300_000 } } });
    expect(watch.context).toBe(24_565);
  });

  test('counts Anthropic start usage and merges partial final usage without losing cached input', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(start({ input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 5 }));
    expect(watch.context).toBe(1_015);
    watch.observe(delta({ input_tokens: 20, output_tokens: 7 }));
    expect(watch.context).toBe(1_025);
    watch.observe(delta({ output_tokens: 9 }));
    expect(watch.context).toBe(1_025);
  });

  test('new messages reset partial usage instead of accumulating prior context', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(start({ input_tokens: 10, cache_read_input_tokens: 1_000 }));
    watch.observe(start({ input_tokens: 0, output_tokens: 0 }));
    expect(watch.context).toBe(1_010);
    watch.observe(delta({ input_tokens: 15 }));
    expect(watch.context).toBe(15);
  });

  test('worker streams cannot replace or contaminate main usage', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(start({ input_tokens: 10, cache_read_input_tokens: 1_000 }));
    watch.observe({ ...start({ input_tokens: 90_000 }), parent_tool_use_id: 'worker-tool' });
    watch.observe({ ...delta({ cache_read_input_tokens: 80_000 }), parent_tool_use_id: 'worker-tool' });
    watch.observe(delta({ input_tokens: 20 }));
    expect(watch.context).toBe(1_020);
  });

  test('compaction clears both the context and partial usage', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(start({ input_tokens: 10, cache_read_input_tokens: 1_000 }));
    watch.observe({ type: 'system', subtype: 'compact_boundary' });
    expect(watch.context).toBe(0);
    watch.observe(delta({ input_tokens: 15 }));
    expect(watch.context).toBe(15);
  });

  test('unrelated stream events and missing usage leave the last context intact', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(start({ input_tokens: 10 }));
    watch.observe(stream({ type: 'content_block_delta', usage: { input_tokens: 80_000 } }));
    watch.observe(stream({ type: 'message_delta' }));
    watch.observe(start({}));
    expect(watch.context).toBe(10);
  });
});
