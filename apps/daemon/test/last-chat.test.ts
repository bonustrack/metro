import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { createMetroMcp } from '../src/mcp/index.ts';
import { forgetLastChat, lastChat, noteLastChat, removeOldOwnerChat, setLastChatFile } from '../src/channels/last-chat.ts';
import { viewFiles } from '../src/agent-user/view.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap, setDisabledAccounts } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { setApprovalAgent } from '../src/approvals/link.ts';
import { initSession, openGet, type GetStream } from './mcp-probe.ts';
import { settle, waitFor } from './wait.ts';

const AGENT = 'agent000001';
const TOKEN = 'mk_last_chat';
const TG = 'tb000000001';
const LINE = `metro://telegram-bot/${TG}/-100777`;
const OTHER_LINE = `metro://telegram-bot/${TG}/-100888`;
const SENDER = `metro://telegram-bot/${TG}/user/111`;

let dir = '';
let file = '';

const saved = (): unknown => JSON.parse(readFileSync(file, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-last-chat-'));
  file = join(dir, 'last-chat.json');
});

afterEach(() => {
  forgetLastChat();
  rmSync(dir, { recursive: true, force: true });
});

describe('the last chat file', () => {
  test('is written 0600 only when the chat changes, and read back after a restart', () => {
    setLastChatFile(file);
    expect(lastChat()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    noteLastChat(LINE);
    expect(saved()).toEqual({ version: 1, line: LINE });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(file);
    noteLastChat(LINE);
    expect(existsSync(file)).toBe(false);
    noteLastChat(OTHER_LINE);
    expect(saved()).toEqual({ version: 1, line: OTHER_LINE });
    forgetLastChat();
    setLastChatFile(file);
    expect(lastChat()).toBe(OTHER_LINE);
  });

  test('a missing, broken or foreign file is ignored, and nothing throws', () => {
    for (const text of ['{not json', '[]', '"metro://x"', JSON.stringify({ line: LINE }), JSON.stringify({ version: 2, line: LINE }), JSON.stringify({ version: 1, line: 42 }), JSON.stringify({ version: 1, line: 'https://evil.example' }), JSON.stringify({ version: 1, line: `metro://${'x'.repeat(1_000)}` })]) {
      writeFileSync(file, text);
      forgetLastChat();
      setLastChatFile(file);
      expect(lastChat()).toBeUndefined();
    }
    forgetLastChat();
    setLastChatFile(join(dir, 'missing.json'));
    expect(lastChat()).toBeUndefined();
    const folder = join(dir, 'a-folder.json');
    mkdirSync(folder);
    forgetLastChat();
    setLastChatFile(folder);
    expect(lastChat()).toBeUndefined();
    noteLastChat(LINE);
    expect(lastChat()).toBe(LINE);
  });

  test('keeps nothing without a file, and never a line that is not a chat line', () => {
    noteLastChat(LINE);
    expect(lastChat()).toBeUndefined();
    setLastChatFile(file);
    noteLastChat('https://evil.example');
    noteLastChat('');
    expect(lastChat()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test('is never copied into the agent view', () => {
    writeFileSync(file, JSON.stringify({ version: 1, line: LINE }));
    expect([...viewFiles(dir, () => null).keys()]).not.toContain('last-chat.json');
  });
});

describe('the old owner chat file', () => {
  test('is removed at boot with its temp file, and nothing else is touched', () => {
    writeFileSync(join(dir, 'approval-line.json'), JSON.stringify({ line: LINE, from: SENDER }));
    writeFileSync(join(dir, 'approval-line.json.tmp-123'), '{');
    writeFileSync(join(dir, 'approval-line.json.bak'), '{}');
    writeFileSync(join(dir, '.tail-lock'), '1');
    expect(removeOldOwnerChat(dir)).toBe(2);
    expect(existsSync(join(dir, 'approval-line.json'))).toBe(false);
    expect(existsSync(join(dir, 'approval-line.json.tmp-123'))).toBe(false);
    expect(existsSync(join(dir, 'approval-line.json.bak'))).toBe(true);
    expect(existsSync(join(dir, '.tail-lock'))).toBe(true);
  });

  test('a folder or a link with that name is left alone, and a missing folder is harmless', () => {
    mkdirSync(join(dir, 'approval-line.json'));
    expect(removeOldOwnerChat(dir)).toBe(0);
    expect(existsSync(join(dir, 'approval-line.json'))).toBe(true);
    const other = mkdtempSync(join(tmpdir(), 'metro-last-chat-link-'));
    try {
      writeFileSync(join(other, 'target'), 'keep');
      symlinkSync(join(other, 'target'), join(other, 'approval-line.json'));
      expect(removeOldOwnerChat(other)).toBe(0);
      expect(readFileSync(join(other, 'target'), 'utf8')).toBe('keep');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect(removeOldOwnerChat(join(dir, 'missing'))).toBe(0);
  });
});

describe('a permission prompt after a restart', () => {
  let sends: Record<string, unknown>[] = [];
  let handler: Awaited<ReturnType<typeof createMetroMcp>> | undefined;
  let server: Server | undefined;
  let url = '';
  let sessionId = '';
  let stream: GetStream | undefined;

  const chat = async (line: string, text: string): Promise<void> => {
    publishEvent({
      id: `ev-${randomUUID()}`,
      ts: new Date().toISOString(),
      station: 'telegram-bot',
      line: asLine(line),
      from: asLine(SENDER),
      to: asLine(line),
      text,
      messageId: `mm-${randomUUID()}`,
      event: { type: 'msg' },
    } as unknown as MetroEvent);
    await waitFor(() => stream?.raw().includes(text) === true);
  };

  async function restart(): Promise<void> {
    await stream?.stop();
    forgetLastChat();
    setLastChatFile(file);
    handler = await createMetroMcp();
    handler.startInbound();
    sessionId = await initSession(url);
    stream = await openGet(url, sessionId);
  }

  async function ask(requestId: string): Promise<string | undefined> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: requestId, tool_name: 'Bash', description: 'Run a command', input_preview: '{"command":"ls"}' } }),
    });
    await res.body?.cancel();
    await waitFor(() => pendingPrompts().some((p) => p.requestId === requestId));
    await settle(30);
    return pendingPrompts().find((p) => p.requestId === requestId)?.line;
  }

  beforeAll(async () => {
    forgetAllPrompts();
    setApprovalAgent(() => ({ owner: 'org_01LASTCHAT0000000', agent: 'row00000001' }));
    setKeyMap([{ key: TOKEN, agentId: AGENT }]);
    setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
    setAllowlistMap({ [`telegram-bot/${TG}`]: ['111'] });
    server = createServer((req, res) => {
      handler?.httpHandler(req, res).catch(() => undefined);
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp?token=${TOKEN}`;
  });

  afterAll(async () => {
    await stream?.stop();
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    setKeyMap([]);
    setAgentMap({}, {});
    setAllowlistMap({});
    setApprovalAgent(() => ({ owner: null, agent: null }));
    forgetAllPrompts();
  });

  beforeEach(async () => {
    sends = [];
    setTrainCallBackend((_train, action, args) => {
      if (action === 'send') sends.push(args as Record<string, unknown>);
      return Promise.resolve({ result: { messageId: `m-${String(sends.length)}` } });
    });
    await restart();
    await chat(LINE, 'hello before the restart');
    expect(saved()).toEqual({ version: 1, line: LINE });
    await restart();
    sends = [];
  });

  afterEach(() => {
    forgetAllPrompts();
  });

  test('posts its link to the last chat seen before the restart, and a new chat then replaces it', async () => {
    expect(await ask('abcde')).toBe(LINE);
    await waitFor(() => sends.length === 1);
    expect(sends.map((args) => args.line)).toEqual([LINE]);
    await chat(OTHER_LINE, 'a new chat');
    expect(saved()).toEqual({ version: 1, line: OTHER_LINE });
    expect(await ask('bcdef')).toBe(OTHER_LINE);
  });

  test('still waits on metro.box only when that chat left the scope, stopped receiving, or messages are paused', async () => {
    setAgentMap({ [`telegram-bot/${TG}`]: 'agent000002' }, { [AGENT]: 'Andy', agent000002: 'Other' });
    try {
      expect(await ask('cdefg')).toBeUndefined();
    } finally {
      setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
    }
    setDisabledAccounts(new Set([`telegram-bot/${TG}`]));
    try {
      expect(await ask('defgh')).toBeUndefined();
    } finally {
      setDisabledAccounts(new Set());
    }
    handler?.setLiveEvents(false);
    try {
      expect(await ask('efghk')).toBeUndefined();
    } finally {
      handler?.setLiveEvents(true);
    }
    expect(sends).toEqual([]);
  });

  test('a broken file after the restart only means no chat is known', async () => {
    writeFileSync(file, '{broken');
    await restart();
    expect(await ask('fghkm')).toBeUndefined();
    expect(sends).toEqual([]);
  });
});
