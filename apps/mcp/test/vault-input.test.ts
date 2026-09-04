import { describe, expect, test } from 'bun:test';
import { parseVaultInput, VaultError } from '../src/db/vault.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const AGENT = 'bMcXH2uERTe';
const envelope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  keyVersion: 1,
  agentId: AGENT,
  nonce: 'bm9uY2U',
  ciphertext: 'Y2lwaGVy',
  key: { recipient: OWNER, recipientPublicKey: 'cHVi', ephemeralPublicKey: 'ZXBo', nonce: 'bm9uY2U', ciphertext: 'd3JhcA' },
  ...over,
});
const status = (work: () => unknown): number => {
  try {
    work();
    return 0;
  } catch (err) {
    return err instanceof VaultError ? err.status : -1;
  }
};

describe('what the vault accepts', () => {
  test('a v1 envelope sealed to the signed-in wallet, with a name and known stations', () => {
    const out = parseVaultInput(OWNER.toUpperCase().replace('0X', '0x'), AGENT, { name: 'Tony', stations: ['xmtp', 'telegram-bot', 'xmtp'], envelope: envelope() });
    expect(out.owner).toBe(OWNER);
    expect(out.name).toBe('Tony');
    expect(out.stations).toEqual(['xmtp', 'telegram-bot']);
    expect(out.envelope.agentId).toBe(AGENT);
  });

  test('an identity that is not an address has no vault', () => {
    expect(status(() => parseVaultInput('ada@lovelace.dev', AGENT, { name: 'Tony', stations: [], envelope: envelope() }))).toBe(403);
  });

  test('the envelope must be for this agent, name the wallet it is sealed to, and carry ciphertext', () => {
    expect(status(() => parseVaultInput(OWNER, AGENT, { name: 'Tony', stations: [], envelope: envelope({ agentId: 'other000000' }) }))).toBe(400);
    expect(status(() => parseVaultInput(OWNER, AGENT, { name: 'Tony', stations: [], envelope: envelope({ key: { recipient: 'nobody' } }) }))).toBe(400);
    expect(status(() => parseVaultInput(OWNER, AGENT, { name: 'Tony', stations: [], envelope: envelope({ ciphertext: 7 }) }))).toBe(400);
    expect(status(() => parseVaultInput(OWNER, AGENT, { name: 'Tony', stations: [], envelope: envelope({ v: 2 }) }))).toBe(400);
  });

  test('a bad name, an unknown station or a bad id are refused', () => {
    expect(status(() => parseVaultInput(OWNER, AGENT, { name: 'no spaces here', stations: [], envelope: envelope() }))).toBe(400);
    expect(status(() => parseVaultInput(OWNER, AGENT, { name: 'Tony', stations: ['line'], envelope: envelope() }))).toBe(400);
    expect(status(() => parseVaultInput(OWNER, 'nope', { name: 'Tony', stations: [], envelope: envelope({ agentId: 'nope' }) }))).toBe(404);
    expect(status(() => parseVaultInput(OWNER, AGENT, { name: 'Tony', stations: [], envelope: envelope({ ciphertext: 'x'.repeat(2 * 1024 * 1024 + 1) }) }))).toBe(413);
  });
});
