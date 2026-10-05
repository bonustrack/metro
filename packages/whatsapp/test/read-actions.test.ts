import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts } from '../src/accounts.ts';
import { makeHandleCall } from '../src/actions.ts';
import { createClient, type WAClient } from '../src/client.ts';
import { createHistory, type History } from '../src/history.ts';
import { whatsappStation } from '../src/station.ts';

const JID = '123@g.us';
const LINE = `metro://whatsapp/fixture/${JID}`;

describe('WhatsApp read and roster handlers', () => {
  let dir: string;
  let previous: string | undefined;
  let history: History;
  let client: WAClient;
  let calls: { account: string; method: string; args: unknown[] }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metro-wa-read-actions-'));
    previous = process.env.WHATSAPP_TOKEN_DIR;
    process.env.WHATSAPP_TOKEN_DIR = dir;
    const account = { id: 'fixture', phone: '111', credentials: { creds: {} } };
    accounts.set(account.id, account);
    accounts.set('other', { ...account, id: 'other' });
    history = createHistory('fixture');
    client = createClient(account);
    calls = [];
    client.read = (jid, options) => {
      calls.push({ account: '', method: 'read', args: [jid, options] });
      return Promise.resolve(history.read(jid, options));
    };
    client.listMembers = (jid, limit) => {
      calls.push({ account: '', method: 'listMembers', args: [jid, limit] });
      return Promise.resolve({ members: [{ id: '123@lid' }], capability: { supported: true, complete: true, total: 1 } });
    };
  });

  afterEach(async () => {
    await client.disconnect();
    history.close();
    accounts.clear();
    if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
    else process.env.WHATSAPP_TOKEN_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(action: string, args: Record<string, unknown>): Promise<unknown> {
    const output: unknown[] = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      const row: unknown = JSON.parse(String(chunk));
      output.push(row);
      return true;
    };
    try {
      await makeHandleCall((account) => {
        calls.push({ account, method: 'clientFor', args: [] });
        return client;
      })({ op: 'call', id: 'fixture-call', action, args });
    } finally {
      process.stdout.write = write;
    }
    return output.find((row) => typeof row === 'object' && row !== null && 'op' in row && row.op === 'response');
  }

  test('advertises read without advertising unsupported advanced filters or group writes', () => {
    expect(whatsappStation.messageVerbs.has('read')).toBe(true);
    expect(whatsappStation.readFilters?.size ?? 0).toBe(0);
    expect(whatsappStation.groupOps?.size ?? 0).toBe(0);
  });

  test('read forwards existing pagination and normalizes the local result', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    history.ingest([{ key: { remoteJid: JID, id: 'fixture-message', fromMe: true }, message: { conversation: 'sent text' }, messageTimestamp: timestamp }], '447700900111@s.whatsapp.net');
    const result = await call('read', { line: LINE, limit: 10, since: new Date(timestamp * 1000).toISOString() });
    expect(calls[1]).toMatchObject({ method: 'read', args: [JID, { limit: 10, since: new Date(timestamp * 1000).toISOString() }] });
    expect(result).toMatchObject({ result: {
      line: LINE, account: 'fixture', count: 1, hasMore: false,
      messages: [{ id: 'fixture-message', ts: new Date(timestamp * 1000).toISOString(), text: 'sent text', self: true, from: 'metro://whatsapp/fixture/user/447700900111@s.whatsapp.net' }],
      coverage: { partial: true, source: 'local' },
    } });
  });

  test('read account override selects and labels that same account', async () => {
    history.ingest([{ key: { remoteJid: JID, id: 'fixture-message', participant: '123@lid' }, message: { conversation: 'received text' }, messageTimestamp: Math.floor(Date.now() / 1000) }]);
    const result = await call('read', { line: LINE, account: 'other', limit: 3 });
    expect(calls[0]?.account).toBe('other');
    expect(result).toMatchObject({ result: {
      account: 'other', line: `metro://whatsapp/other/${JID}`,
      messages: [{ from: 'metro://whatsapp/other/user/123@lid', self: false }],
    } });
  });

  test('read returns the exclusive local cursor and page metadata unchanged', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 3;
    history.ingest([1, 2, 3].map((index) => ({
      key: { remoteJid: JID, id: `message-${index}`, participant: '123@lid' },
      message: { conversation: `message ${index}` }, messageTimestamp: timestamp + index,
    })));
    expect(await call('read', { line: LINE, limit: 2 })).toMatchObject({ result: {
      messages: [{ id: 'message-3' }, { id: 'message-2' }], count: 2, hasMore: true, nextBefore: 'message-2',
      coverage: { partial: true, source: 'local', retained: 3 },
    } });
    const result = await call('read', { line: LINE, limit: 2, before: 'message-2' });
    expect(result).toMatchObject({ result: { messages: [{ id: 'message-1' }], count: 1, hasMore: false } });
    expect(result).not.toHaveProperty('result.nextBefore');
  });

  test('read exposes attachment metadata but no transport keys or download locations', async () => {
    history.ingest([{
      key: { remoteJid: JID, id: 'image', participant: '123@lid' }, messageTimestamp: Math.floor(Date.now() / 1000),
      message: { imageMessage: { caption: 'image caption', mimetype: 'image/jpeg', fileLength: 123, mediaKey: Buffer.alloc(32), directPath: '/fixture-private-path' } },
    }]);
    const result = await call('read', { line: LINE });
    expect(result).toMatchObject({ result: { messages: [{
      id: 'image', text: expect.stringContaining('image caption'), self: false,
      attachments: [{ kind: 'image', mime: 'image/jpeg', name: 'image.jpg', bytes: 123 }],
    }] } });
    for (const path of ['key', 'mediaKey', 'attachments.0.local_path', 'attachments.0.url', 'attachments.0.directPath'])
      expect(result).not.toHaveProperty(`result.messages.0.${path}`);
  });

  test('read preserves the text truncation notice', async () => {
    history.ingest([{ key: { remoteJid: JID, id: 'long', participant: '123@lid' }, message: { conversation: 'x'.repeat(20_000) }, messageTimestamp: Math.floor(Date.now() / 1000) }]);
    expect(await call('read', { line: LINE })).toMatchObject({ result: { messages: [{ id: 'long', truncated: true }] } });
  });

  test('bounds the final formatted response and paginates escaped text without loss', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    history.ingest(Array.from({ length: 70 }, (_, index) => ({
      key: { remoteJid: JID, id: `escaped-${index}`, participant: `${'1'.repeat(240)}@lid` },
      messageTimestamp: timestamp,
      message: { documentMessage: {
        caption: '\u0001'.repeat(16 * 1024), mimetype: 'application/pdf',
        fileName: '\u0002'.repeat(256), fileLength: 123,
      } },
    })));
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 70; page++) {
      const response = await call('read', { line: LINE, limit: 100, before });
      if (typeof response !== 'object' || response === null || !('result' in response))
        throw new Error('Missing history response');
      expect(Buffer.byteLength(JSON.stringify(response.result, null, 2))).toBeLessThanOrEqual(2 * 1024 * 1024);
      const result = response.result;
      if (typeof result !== 'object' || result === null || !('messages' in result) || !Array.isArray(result.messages))
        throw new Error('Missing history messages');
      expect(result.messages.length).toBeGreaterThan(0);
      for (const message of result.messages) {
        if (typeof message !== 'object' || message === null || !('id' in message) || typeof message.id !== 'string')
          throw new Error('Missing history message ID');
        expect(seen.has(message.id)).toBe(false);
        seen.add(message.id);
      }
      if (!('hasMore' in result) || !result.hasMore) break;
      if (!('nextBefore' in result) || typeof result.nextBefore !== 'string')
        throw new Error('Missing history continuation');
      before = result.nextBefore;
    }
    expect(seen.size).toBe(70);
  });

  test('read refuses bad targets and invalid cursors rather than silently starting over', async () => {
    expect(await call('read', { line: 'metro://telegram/fixture/123' })).toMatchObject({ error: expect.stringContaining('bad line') });
    expect(await call('read', { account: 'fixture' })).toMatchObject({ error: expect.stringContaining('missing line') });
    expect(calls).toEqual([]);
    expect(await call('read', { line: LINE, before: 'unknown' })).toMatchObject({ errorInfo: { code: 'whatsapp_history_cursor' } });
    expect(await call('read', { line: LINE, limit: 0 })).toMatchObject({ errorInfo: { code: 'bad_request' } });
    expect(await call('read', { line: LINE, since: 'not-a-timestamp' })).toMatchObject({ errorInfo: { code: 'bad_request' } });
  });

  test('listMembers uses only the line account and preserves capability', async () => {
    const result = await call('listMembers', { line: LINE, account: 'other', limit: 2 });
    expect(calls[0]?.account).toBe('fixture');
    expect(calls[1]).toMatchObject({ method: 'listMembers', args: [JID, 2] });
    expect(result).toMatchObject({ result: { members: [{ id: '123@lid' }], capability: { supported: true, complete: true, total: 1 } } });
  });

  test('upstream roster errors remain errors', async () => {
    client.listMembers = () => Promise.reject(new Error('403 forbidden'));
    expect(await call('listMembers', { line: LINE })).toMatchObject({ error: expect.stringContaining('403 forbidden') });
  });
});
