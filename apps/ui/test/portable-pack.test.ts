import { describe, expect, test } from 'bun:test';
import {
  digest,
  fileName,
  gunzip,
  gzip,
  openMetroFile,
  packFile,
  parseMetroFile,
  parsePayload,
  sealedWith,
  sectionsIn,
  type Payload,
} from '../src/export/pack.js';

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

const PASSPHRASE = 'correct horse battery staple';

describe('a .metro export file', () => {
  test('round trips through gzip, the passphrase seal and back, with every section intact', async () => {
    const file = await packFile(PAYLOAD, PASSPHRASE);
    expect(file.metro).toBe(1);
    expect(file.kind).toBe('agent-export');
    expect(sealedWith(file)).toBe('passphrase');

    const text = JSON.stringify(file);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('vault.example');
    expect(text).not.toContain('Alice');
    expect(text).not.toContain('this is private');
    expect(text).not.toContain('sk-or-private-key');
    expect(text).not.toContain(PASSPHRASE);

    const opened = await openMetroFile(text, PASSPHRASE);
    expect(opened).toEqual(PAYLOAD);
    expect(sectionsIn(opened)).toEqual(['channels', 'connectors', 'skills', 'memory', 'sessions', 'model']);
  });

  test('a wrong passphrase and a tampered ciphertext are refused', async () => {
    const text = JSON.stringify(await packFile(PAYLOAD, PASSPHRASE));
    await expect(openMetroFile(text, 'not it')).rejects.toThrow('does not open');
    const file = await packFile(PAYLOAD, PASSPHRASE);
    const broken = { ...file, envelope: { ...file.envelope, ciphertext: `AAAA${String(file.envelope.ciphertext).slice(4)}` } };
    await expect(openMetroFile(JSON.stringify(broken), PASSPHRASE)).rejects.toThrow();
  });

  test('a file from before passphrases, sealed to a wallet, is refused with the reason', async () => {
    const legacy = JSON.stringify({ metro: 1, kind: 'agent-export', envelope: { v: 1, keyVersion: 1, agentId: 'agent000001', nonce: 'AAAA', ciphertext: 'AAAA', key: { recipient: '0xabc' } } });
    expect(sealedWith(parseMetroFile(legacy))).toBe('wallet');
    await expect(openMetroFile(legacy, PASSPHRASE)).rejects.toThrow('sealed to a wallet');
  });

  test('anything that is not an export file is refused before the passphrase is asked', () => {
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
    const only = { ...PAYLOAD, connectors: undefined, skills: undefined, memory: undefined, sessions: undefined, model: undefined };
    const opened = await openMetroFile(JSON.stringify(await packFile(only, PASSPHRASE)), PASSPHRASE);
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

  test('the file is named after the server, the moment, and a hash of what it holds', async () => {
    const at = new Date(2026, 8, 17, 14, 5);
    const hash = await digest('{"metro":1}');
    expect(hash).toHaveLength(64);
    expect(fileName('mci-rosa', at, hash)).toBe(`mci-rosa-2026-09-17-${hash.slice(0, 16)}.metro`);
    expect(fileName('Anderra Andy', at, hash)).toStartWith('anderra-andy-2026-09-17-');
    expect(fileName('!!', at, hash)).toStartWith('metro-2026-09-17-');
    expect(await digest('{"metro":1}')).toBe(hash);
    expect(await digest('{"metro":2}')).not.toBe(hash);
  });
});
