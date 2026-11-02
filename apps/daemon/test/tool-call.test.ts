import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToolCall } from '../src/claude/tool-call.ts';

const dir = mkdtempSync(join(tmpdir(), 'metro-tool-call-'));
const project = '-home-agent';
const session = '4dc97101-8c7a-4c03-ba73-702a3313882e';
const root = join(dir, 'projects', project);
mkdirSync(join(root, session, 'subagents'), { recursive: true });

const line = (type: string, content: unknown[], at: string): string => JSON.stringify({ type, timestamp: at, message: { role: type, content } });

writeFileSync(join(root, `${session}.jsonl`), [
  line('user', [{ type: 'text', text: 'Hello' }], '2026-11-02T07:50:00Z'),
  line('assistant', [{ type: 'tool_use', id: 'toolu_main', name: 'mcp__metro__react', input: { line: 'metro://xmtp/a/b', message_id: 'm1', emoji: '👀' } }], '2026-11-02T07:50:01Z'),
  'not json',
  line('user', [{ type: 'tool_result', tool_use_id: 'toolu_main', is_error: true, content: [{ type: 'text', text: 'NOT_FOUND: could not resolve referenceInboxId for m1' }] }], '2026-11-02T07:50:02Z'),
  line('assistant', [{ type: 'tool_use', id: 'toolu_open', name: 'Bash', input: { command: 'sleep 60' } }], '2026-11-02T07:50:03Z'),
].join('\n'));

writeFileSync(join(root, session, 'subagents', 'agent-a1.jsonl'), [
  line('assistant', [{ type: 'tool_use', id: 'toolu_worker', name: 'Read', input: { file_path: '/home/agent/x' } }], '2026-11-02T07:51:00Z'),
  line('user', [{ type: 'tool_result', tool_use_id: 'toolu_worker', content: 'file text' }], '2026-11-02T07:51:01Z'),
].join('\n'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reading one tool call of a session', () => {
  test('a failed call of the main thread comes back with its input and its error', async () => {
    const call = await readToolCall(project, session, 'toolu_main', dir);
    expect(call?.name).toBe('mcp__metro__react');
    expect(call?.input).toContain('"message_id": "m1"');
    expect(call?.result).toBe('NOT_FOUND: could not resolve referenceInboxId for m1');
    expect(call?.isError).toBe(true);
    expect(call?.calledAt).toBe('2026-11-02T07:50:01Z');
    expect(call?.answeredAt).toBe('2026-11-02T07:50:02Z');
  });

  test('a worker call is found in its own transcript, and the project is found when not given', async () => {
    const call = await readToolCall(null, session, 'toolu_worker', dir);
    expect(call).toMatchObject({ name: 'Read', result: 'file text', isError: false });
  });

  test('a call still running has no result, an unknown one is null', async () => {
    expect((await readToolCall(project, session, 'toolu_open', dir))?.result).toBeNull();
    expect(await readToolCall(project, session, 'toolu_missing', dir)).toBeNull();
    expect(await readToolCall(null, '00000000-0000-0000-0000-000000000000', 'toolu_main', dir)).toBeNull();
  });

  test('a malformed id is refused before any path is built', async () => {
    await expect(readToolCall(project, session, '../../etc/passwd', dir)).rejects.toThrow('that is not a tool call id');
    await expect(readToolCall(project, '../x', 'toolu_main', dir)).rejects.toThrow('that is not a session id');
  });
});
