import { describe, expect, test } from 'bun:test';
import { takesToolSearch, withoutToolSearch } from '../src/gateway/tool-search.ts';
import type { Provider } from '../src/gateway/model-config.ts';
import { makeConnection } from './model-fixture.ts';

const route = (provider: Provider, model: string): Parameters<typeof takesToolSearch>[0] => ({ connection: makeConnection(provider), model });

describe('which route takes MCP tool search', () => {
  test('only Anthropic, and only a model from the 4.5 generation on', () => {
    for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'])
      expect(takesToolSearch(route('anthropic', model))).toBe(true);
    for (const model of ['claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-0', 'claude-sonnet-4', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-latest'])
      expect(takesToolSearch(route('anthropic', model))).toBe(false);
    for (const provider of ['bedrock', 'openrouter', 'codex', 'gemini'] as const) expect(takesToolSearch(route(provider, 'claude-sonnet-5'))).toBe(false);
  });

  test('a request without deferred tools or tool references is left as it is', () => {
    const body = { model: 'x', tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }] };
    expect(withoutToolSearch(body)).toBe(body);
    const bare = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
    expect(withoutToolSearch(bare)).toBe(bare);
  });
});
