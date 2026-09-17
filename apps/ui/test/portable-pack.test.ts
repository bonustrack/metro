import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { walletKeys } from '../src/vault/crypto.js';
import {
  fileName,
  gunzip,
  gzip,
  openMetroFile,
  packFile,
  parseMetroFile,
  parsePayload,
  sectionsIn,
  type Payload,
} from '../src/export/pack.js';

const ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

async function keysFor(account = ACCOUNT): Promise<Awaited<ReturnType<typeof walletKeys>>> {
  const signature = await account.signMessage({ message: 'metro export test' });
  return walletKeys(account.address, signature);
}

const PAYLOAD: Payload = {
  version: 1,
  exportedAt: '2026-09-16T00:00:00.000Z',
  agent: { id: 'agent000001', name: 'Alice' },
  channels: [
    { station: 'telegram-bot', id: 'a1-abcdef01', allowlist: ['*'], config: { token: 'secret-token' } },
  ],
  connectors: [
    { id: 'conn0000001', name: 'Vault', url: 'https://vault.example/mcp', transport: 'http', config: {} },
  ],
  skills: [{ place: 'user', name: 'metro-orchestrator', text: '# rules\n' }],
  memory: [{ project: 'proj', name: 'note.md', text: '# note\n', modifiedAt: '2026-09-10T08:00:00.000Z' }],
  sessions: [{ project: 'proj', id: '11111111-2222-4333-8444-555555555555', text: '{"type":"user","message":{"content":"hello, this is private"}}\n' }],
  model: [{ version: 1, provider: 'openrouter', openrouter: { apiKey: 'sk-or-private-key', model: 'google/gemini-3.8-flash', zdr: true } }],
};

describe('a .metro export file', () => {
  test('round trips through gzip, the seal and back, with every section intact', async () => {
    const wallet = await keysFor();
    const file = await packFile(PAYLOAD, wallet);
    expect(file.metro).toBe(1);
    expect(file.kind).toBe('agent-export');

    const text = JSON.stringify(file);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('vault.example');
    expect(text).not.toContain('Alice');
    expect(text).not.toContain('this is private');
    expect(text).not.toContain('sk-or-private-key');

    const opened = await openMetroFile(text, wallet);
    expect(opened).toEqual(PAYLOAD);
    expect(sectionsIn(opened)).toEqual(['channels', 'connectors', 'skills', 'memory', 'sessions', 'model']);
  });

  test('a file sealed for another wallet is refused by name, not by a decryption error', async () => {
    const mine = await keysFor();
    const theirs = await keysFor(privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'));
    const file = JSON.stringify(await packFile(PAYLOAD, theirs));
    await expect(openMetroFile(file, mine)).rejects.toThrow(theirs.address.toLowerCase());
  });

  test('a tampered ciphertext does not open', async () => {
    const wallet = await keysFor();
    const file = await packFile(PAYLOAD, wallet);
    const broken = { ...file, envelope: { ...file.envelope, ciphertext: `AAAA${file.envelope.ciphertext.slice(4)}` } };
    await expect(openMetroFile(JSON.stringify(broken), wallet)).rejects.toThrow();
  });

  test('anything that is not an export file is refused before the wallet is asked', () => {
    expect(() => parseMetroFile('not json')).toThrow('not a metro export file');
    expect(() => parseMetroFile(JSON.stringify({ metro: 2, kind: 'agent-export', envelope: {} }))).toThrow(
      'not a metro export file',
    );
    expect(() => parseMetroFile(JSON.stringify({ metro: 1, kind: 'vault', envelope: {} }))).toThrow(
      'not a metro export file',
    );
    expect(() => parseMetroFile(JSON.stringify({ metro: 1, kind: 'agent-export' }))).toThrow('carries nothing');
  });

  test('a section left out of the export stays absent rather than arriving empty', async () => {
    const wallet = await keysFor();
    const only = { ...PAYLOAD, connectors: undefined, skills: undefined, memory: undefined, sessions: undefined, model: undefined };
    const opened = await openMetroFile(JSON.stringify(await packFile(only, wallet)), wallet);
    expect(sectionsIn(opened)).toEqual(['channels']);
    expect(opened.connectors).toBeUndefined();
  });

  test('gzip actually compresses, and a payload with a bad entry is named', async () => {
    const packed = await gzip('a'.repeat(4000));
    expect(packed.length).toBeLessThan(500);
    expect(await gunzip(packed)).toBe('a'.repeat(4000));
    expect(() => parsePayload({ version: 1, agent: {}, channels: [{ station: 'telegram-bot' }] })).toThrow('channel');
    expect(() => parsePayload({ version: 2 })).toThrow('not a v1 export');
  });

  test('the file is named after the agent', () => {
    expect(fileName('Anderra Andy')).toBe('anderra-andy.metro');
    expect(fileName('!!')).toBe('agent.metro');
  });
});
