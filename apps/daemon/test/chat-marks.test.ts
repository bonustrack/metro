import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_MCP_HEADER } from '@metro-labs/core/chat';
import { previewOf } from '../../mcp/src/preview.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { createMetroMcp } from '../src/mcp/index.ts';
import { askedByChat, forgetChatMarks, markChatCalls, serverPreview, setChatMarksFile } from '../src/mcp-server/chat-marks.ts';

const TOKEN = 'mk_chat_marks';
const CALL = { tool: 'gmail.send', arguments: { to: 'a@b.c', subject: 'Hi', body: 'x'.repeat(2_000) } };
const ASKED = { id: 'abcde', connector: 'gmail', tool: 'send', preview: previewOf(CALL.arguments) };

let server: Server | undefined;
let url = '';
let dir = '';

const toolCall = async (headers: Record<string, string>): Promise<void> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'mcp-session-id': crypto.randomUUID(), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_call', arguments: { calls: [CALL] } } }),
  });
  await res.text();
};

beforeAll(async () => {
  setKeyMap([{ key: TOKEN, agentId: 'agent000001' }]);
  const handler = await createMetroMcp();
  server = createServer((req, res) => {
    handler.httpHandler(req, res).catch(() => undefined);
  });
  const port = randomInt(10_000, 30_000);
  await new Promise<void>((r) => server?.listen(port, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${String(port)}/mcp?token=${TOKEN}`;
});

afterAll(async () => {
  setKeyMap([]);
  forgetChatMarks();
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

beforeEach(() => {
  forgetChatMarks();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'metro-chat-marks-'));
  setChatMarksFile(join(dir, 'chat-approvals.json'));
});

describe('the calls a metro.box chat makes through tool_call', () => {
  test('are marked before they leave, from the chat client only, with the preview mcp.metro.box writes', async () => {
    expect(serverPreview(CALL.arguments)).toBe(previewOf(CALL.arguments));
    await toolCall({});
    expect(askedByChat(ASKED)).toBe(false);
    await toolCall({ [CHAT_MCP_HEADER]: '1' });
    expect(askedByChat({ ...ASKED, id: 'bcdef', preview: previewOf({ ...CALL.arguments, body: 'other' }) })).toBe(false);
    expect(askedByChat({ ...ASKED, id: 'bcdef', connector: 'gmail-work' })).toBe(false);
    expect(askedByChat(ASKED)).toBe(true);
  });

  test('a mark is used once: the same call from the agent session afterwards is the session’s, while the chat’s approval stays the chat’s after a restart', () => {
    markChatCalls({ calls: [CALL] });
    expect(askedByChat(ASKED)).toBe(true);
    expect(askedByChat({ ...ASKED, id: 'cdefg' })).toBe(false);
    forgetChatMarks();
    setChatMarksFile(join(dir, 'chat-approvals.json'));
    expect(askedByChat(ASKED)).toBe(true);
    expect(askedByChat({ ...ASKED, id: 'cdefg' })).toBe(false);
  });

  test('a mark waits a few minutes for its approval and survives a restart, an approval is kept a day, and a broken file or hostile call marks nothing', () => {
    const now = Date.now();
    markChatCalls({ calls: [CALL] }, now);
    forgetChatMarks();
    setChatMarksFile(join(dir, 'chat-approvals.json'), now);
    expect(askedByChat(ASKED, now + 11 * 60_000)).toBe(false);
    markChatCalls({ calls: [CALL] }, now);
    expect(askedByChat(ASKED, now + 9 * 60_000)).toBe(true);
    expect(askedByChat(ASKED, now + 23 * 3_600_000)).toBe(true);
    expect(askedByChat(ASKED, now + 25 * 3_600_000)).toBe(false);
    forgetChatMarks();
    writeFileSync(join(dir, 'bad.json'), '{"version":1,"marks":{"../x":1,"short":2},"asks":{"ABCDE":1,"abcde":"x"}}');
    setChatMarksFile(join(dir, 'bad.json'));
    expect(askedByChat(ASKED)).toBe(false);
    for (const args of [{}, { calls: 'x' }, { calls: [{ tool: 'no dot' }] }]) markChatCalls(args);
    expect(askedByChat({ id: 'defgh', connector: 'no', tool: 'dot', preview: '{}' })).toBe(false);
  });
});
