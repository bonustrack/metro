import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAgentMap } from '../src/agents/map.ts';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { callToolHandler, scopeDenied } from '../src/mcp/tool-dispatch.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';

interface Call {
  train: string;
  action: string;
  args: Record<string, unknown>;
}

const AGENT = 'agentA0001';
const OTHER = 'agentB0001';
const OUTLOOK_LINE = 'metro://outlook/o1/AAQkAD=';

let calls: Call[] = [];
let answer: unknown = { messages: [] };

beforeEach(() => {
  calls = [];
  answer = { messages: [] };
  setAgentMap({ 'outlook/o1': AGENT, 'outlook/o2': OTHER, 'xmtp/x1': AGENT }, { [AGENT]: 'ada', [OTHER]: 'bob' });
  setTrainCallBackend((train, action, args) => {
    calls.push({ train, action, args: args as Record<string, unknown> });
    return Promise.resolve({ result: answer });
  });
});

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n');

const asAda = (name: string, args: Record<string, unknown>): ReturnType<typeof callToolHandler> =>
  runWithIdentity({ kind: 'agent', agentId: AGENT }, () => callToolHandler({ params: { name, arguments: args } }));

describe('read on a station that knows only history', () => {
  test('forwards every argument, and names the filters the station does not apply', async () => {
    answer = [{ id: 'm1' }];
    const res = await dispatchMessageTool('read', {
      line: 'metro://xmtp/x1/0xabc',
      limit: 5,
      query: 'invoice',
      from: 'bea',
      until: '2026-09-20',
      unread_only: true,
      message_id: 'm9',
    });
    expect(calls).toEqual([
      {
        train: 'xmtp',
        action: 'read',
        args: { line: 'metro://xmtp/x1/0xabc', limit: 5, query: 'invoice', from: 'bea', until: '2026-09-20', unreadOnly: true, messageId: 'm9' },
      },
    ]);
    expect(JSON.parse(text(res))).toEqual({ result: [{ id: 'm1' }], ignored: ['query', 'from', 'until', 'unread_only', 'message_id'] });
  });

  test('an answer is unchanged when no new filter was asked for', async () => {
    answer = { messages: ['x'] };
    const res = await dispatchMessageTool('read', { line: 'metro://xmtp/x1/0xabc', limit: 3, before: 'm2', since: '2026-09-01' });
    expect(calls[0]?.args).toEqual({ line: 'metro://xmtp/x1/0xabc', limit: 3, before: 'm2', since: '2026-09-01' });
    expect(JSON.parse(text(res))).toEqual({ messages: ['x'] });
  });

  test('a whole-account read is refused where the station reads one conversation at a time', async () => {
    const res = await asAda('read', { account: 'x1' });
    expect(text(res)).toContain('xmtp reads one conversation at a time');
    expect(calls).toEqual([]);
  });

  test('the verb gate still refuses a station that does not read', async () => {
    const res = await dispatchMessageTool('read', { line: 'metro://threema/t0/ECHOECHO' });
    expect(text(res)).toContain('threema does not support read');
    expect(calls).toEqual([]);
  });
});

describe('read on Outlook', () => {
  test('a read with no line and no account is refused before any call', async () => {
    const res = await asAda('read', { query: 'invoice' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('read requires `line` or `account`');
    expect(calls).toEqual([]);
  });

  test('an account-wide read reaches the train with the filters it applies, and nothing is ignored', async () => {
    const res = await asAda('read', { account: 'o1', query: 'invoice', unread_only: true });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([{ train: 'outlook', action: 'read', args: { account: 'o1', query: 'invoice', unreadOnly: true } }]);
    expect(JSON.parse(text(res))).toEqual({ messages: [] });
  });

  test("another agent's account and an unknown account are out of scope", async () => {
    expect(scopeDenied({ kind: 'agent', agentId: AGENT }, 'read', { account: 'o2' })).toBe(true);
    expect(scopeDenied({ kind: 'agent', agentId: AGENT }, 'read', { account: 'nope' })).toBe(true);
    expect(scopeDenied({ kind: 'agent', agentId: AGENT }, 'read', { account: 'o1' })).toBe(false);
    const res = await asAda('read', { account: 'o2' });
    expect(text(res)).toContain('outside your authorized scope');
    expect(calls).toEqual([]);
  });

  test('a full message hands its files back with a url, like inbound media', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-read-attach-'));
    process.env.METRO_XMTP_ATTACH_DIR = dir;
    const path = join(dir, 'msg_0123456789abcdef_0.txt');
    writeFileSync(path, 'hi');
    answer = { account: 'o1', message: { message_id: 'r9', attachments: [{ name: 'notes.txt', local_path: path }] } };
    const res = await asAda('read', { line: OUTLOOK_LINE, message_id: 'r9' });
    expect(calls[0]?.args).toEqual({ line: OUTLOOK_LINE, messageId: 'r9' });
    const body = JSON.parse(text(res)) as { message: { attachments: { url?: string; local_path: string }[] } };
    const [file] = body.message.attachments;
    expect(file?.local_path).toBe(path);
    expect(file?.url).toContain('/attach/msg_0123456789abcdef_0.txt?token=at_');
  });
});
