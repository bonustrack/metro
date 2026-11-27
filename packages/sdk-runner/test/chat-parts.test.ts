import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { chatPartOf, type TurnEvent } from '@metro-labs/core/chat';
import { ChatParts } from '../src/chat-parts.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatEnv, chatOptions, kept } from '../src/chat-turn.ts';
import { runnerConfig } from '../src/config.ts';

const main = { parent_tool_use_id: null, uuid: 'u', session_id: 's' };
const stream = (event: Record<string, unknown>, parent: string | null = null): SDKMessage => ({ type: 'stream_event', event, ...main, parent_tool_use_id: parent }) as never;
const assistant = (id: string, content: unknown[]): SDKMessage => ({ type: 'assistant', message: { id, content }, ...main }) as never;
const user = (content: unknown[]): SDKMessage => ({ type: 'user', message: { role: 'user', content }, ...main }) as never;

function collect(): { parts: ChatParts; events: TurnEvent[] } {
  const events: TurnEvent[] = [];
  return { parts: new ChatParts((e) => events.push(e)), events };
}

describe('the chat turn reads the SDK stream into parts', () => {
  test('streamed text arrives as deltas, a tool call gets its input and result, and the final message adds no copy', () => {
    const { parts, events } = collect();
    parts.take(stream({ type: 'message_start', message: { id: 'm1' } }));
    parts.take(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    parts.take(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } }));
    parts.take(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
    parts.take(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me ' } }));
    parts.take(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'check.' } }));
    parts.take(stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'Bash' } }));
    parts.take(assistant('m1', [{ type: 'text', text: 'Let me check.' }]));
    parts.take(assistant('m1', [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'date' } }]));
    parts.take(user([{ type: 'tool_result', tool_use_id: 'tool_1', content: [{ type: 'text', text: 'Fri' }], is_error: false }]));
    expect(parts.parts).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool', id: 'tool_1', name: 'Bash', input: '{"command":"date"}', result: 'Fri', ok: true },
    ]);
    expect(events.filter((e) => e.t === 'delta').map((e) => (e.t === 'delta' ? e.d : ''))).toEqual(['Let me ', 'check.']);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  test('a message that was not streamed still shows its text and tools', () => {
    const { parts } = collect();
    parts.take(assistant('m2', [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a' } }]));
    parts.take(user([{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }]));
    expect(parts.parts).toEqual([{ type: 'text', text: 'Done.' }, { type: 'tool', id: 't2', name: 'Read', input: '{"file_path":"/a"}', result: 'boom', ok: false }]);
  });

  test('a worker’s own messages stay out of the chat', () => {
    const { parts } = collect();
    parts.take(stream({ type: 'message_start', message: { id: 'w1' } }, 'tool_9'));
    parts.take(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'inner' } }, 'tool_9'));
    parts.take({ type: 'assistant', message: { id: 'w1', content: [{ type: 'text', text: 'inner' }] }, ...main, parent_tool_use_id: 'tool_9' } as never);
    expect(parts.parts).toEqual([]);
  });

  test('an approval waits as a part and then shows its answer', () => {
    const { parts, events } = collect();
    const n = parts.ask('abcde', 'Bash', { command: 'rm -rf /tmp/x' });
    expect(n).toBe(0);
    parts.answered(0, 'allowed');
    expect(parts.parts).toEqual([{ type: 'approval', id: 'abcde', tool: 'Bash', input: '{"command":"rm -rf /tmp/x"}', state: 'allowed' }]);
    expect(events).toHaveLength(2);
  });

  test('tool ids and names the daemon would refuse are made safe, and the result still finds its call', () => {
    const { parts, events } = collect();
    parts.take(assistant('m2', [{ type: 'tool_use', id: 'call|1 x', name: 'mcp__my server__do/it', input: {} }]));
    parts.take(user([{ type: 'tool_result', tool_use_id: 'call|1 x', content: 'ok' }]));
    expect(parts.ask('abcde', 'x'.repeat(300), {})).toBe(1);
    expect(parts.parts).toEqual([
      { type: 'tool', id: 'call_1_x', name: 'mcp__my_server__do_it', input: '', result: 'ok', ok: true },
      { type: 'approval', id: 'abcde', tool: 'x'.repeat(128), input: '', state: 'waiting' },
    ]);
    expect(events.filter((e): e is Extract<TurnEvent, { t: 'part' }> => e.t === 'part').every((e) => chatPartOf(e.part) !== null)).toBe(true);
  });

  test('the chat session reaches metro as a chat client, held to the Gateway page model', () => {
    const cfg = runnerConfig({ METRO_RUNNER_MCP_URL: 'http://127.0.0.1:8420/mcp', METRO_AGENT_KEY: 'mk_x', METRO_RUNNER_MODEL: 'claude-sonnet-5-5', HOME: '/home/agent' }, '/');
    const options = chatOptions(cfg, null, () => Promise.resolve({ behavior: 'deny', message: 'no' }), {});
    expect(options.mcpServers).toEqual({ metro: { type: 'http', url: 'http://127.0.0.1:8420/mcp', headers: { authorization: 'Bearer mk_x', 'x-metro-chat': '1' } } });
    expect(options.model).toBe('claude-sonnet-5-5');
    expect(options.env).toMatchObject({ METRO_SESSION: 'chat' });
  });

  test('the chat session runs without the model pins and is marked as a chat for the hooks', () => {
    const env = chatEnv({ ANTHROPIC_MODEL: 'x', CLAUDE_CODE_SUBAGENT_MODEL: 'y', HOME: '/home/agent' });
    expect(env).toMatchObject({ HOME: '/home/agent', METRO_SESSION: 'chat', DISABLE_AUTOUPDATER: '1' });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  test('a chat resumes its session only while its transcript is still on the box', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-chat-claude-'));
    try {
      expect(kept(dir, '/home/agent', 'a7fb5be2-f586-40cd-a384-7121b757f759')).toBeNull();
      mkdirSync(join(dir, 'projects', '-home-agent'), { recursive: true });
      expect(kept(dir, '/home/agent', 'a7fb5be2-f586-40cd-a384-7121b757f759')).toBeNull();
      writeFileSync(join(dir, 'projects', '-home-agent', 'a7fb5be2-f586-40cd-a384-7121b757f759.jsonl'), '{}\n');
      expect(kept(dir, '/home/agent', 'a7fb5be2-f586-40cd-a384-7121b757f759')).toBe('a7fb5be2-f586-40cd-a384-7121b757f759');
      expect(kept(dir, '/home/other', 'a7fb5be2-f586-40cd-a384-7121b757f759')).toBeNull();
      expect(kept(dir, '/home/agent', null)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
