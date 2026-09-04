import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import {
  ENCRYPTION_KEY_TYPED_DATA,
  fromBase64Url,
  openBundle,
  sealBundle,
  signVaultRequest,
  toBase64Url,
  vaultChallenge,
  walletKeys,
  type Envelope,
} from '../src/vault/crypto';

const OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const AGENT = 'bMcXH2uERTe';
const BUNDLE = JSON.stringify({ version: 1, agent: { id: AGENT, key: 'mk_secret' }, connectors: [{ id: 'c1', config: { auth: { value: 'Bearer vendor' } } }] });

const signFor = (account: typeof OWNER): Promise<`0x${string}`> => account.signTypedData(ENCRYPTION_KEY_TYPED_DATA);

describe('the wallet key', () => {
  test('is derived from one EIP-712 signature, deterministically, and differs per wallet', async () => {
    const sig = await signFor(OWNER);
    const a = await walletKeys(OWNER.address, sig);
    const b = await walletKeys(OWNER.address, await signFor(OWNER));
    expect(toBase64Url(a.privateKey)).toBe(toBase64Url(b.privateKey));
    expect(a.publicKey).toHaveLength(33);
    expect(a.privateKey).toHaveLength(32);
    expect(a.address).toBe(OWNER.address.toLowerCase());
    const other = await walletKeys(OTHER.address, await signFor(OTHER));
    expect(toBase64Url(other.publicKey)).not.toBe(toBase64Url(a.publicKey));
    expect(a.vault.address).toBe(b.vault.address);
    expect(a.vault.address).not.toBe(other.vault.address);
    expect(a.vault.address.toLowerCase()).not.toBe(OWNER.address.toLowerCase());
  });

  test('a vault request is signed by the derived identity, and only it verifies', async () => {
    const keys = await walletKeys(OWNER.address, await signFor(OWNER));
    const header = await signVaultRequest(keys, 'GET', '/api/vault', 1_700_000_000_000);
    const [scheme, address, at, signature] = header.split(' ');
    expect(scheme).toBe('Vault');
    expect(address).toBe(keys.vault.address);
    expect(at).toBe('1700000000000');
    const message = vaultChallenge('GET', '/api/vault', 1_700_000_000_000);
    expect(await verifyMessage({ address: keys.vault.address, message, signature: signature as `0x${string}` })).toBe(true);
    expect(await verifyMessage({ address: OWNER.address, message, signature: signature as `0x${string}` })).toBe(false);
  });

  test('the typed data pins the domain and message the doc names', () => {
    expect(ENCRYPTION_KEY_TYPED_DATA.domain).toEqual({ name: 'metro', version: '1' });
    expect(ENCRYPTION_KEY_TYPED_DATA.message).toEqual({ purpose: 'encryption-key', keyVersion: 1n });
  });
});

describe('sealing a bundle', () => {
  test('round-trips for the wallet it was sealed to, and the envelope carries no plaintext', async () => {
    const wallet = await walletKeys(OWNER.address, await signFor(OWNER));
    const envelope = await sealBundle(BUNDLE, AGENT, wallet);
    expect(envelope.v).toBe(1);
    expect(envelope.agentId).toBe(AGENT);
    expect(envelope.key.recipient).toBe(OWNER.address.toLowerCase());
    expect(JSON.stringify(envelope)).not.toContain('mk_secret');
    expect(JSON.stringify(envelope)).not.toContain('vendor');
    expect(await openBundle(envelope, wallet)).toBe(BUNDLE);
  });

  test('another wallet is refused by name, before any decryption', async () => {
    const owner = await walletKeys(OWNER.address, await signFor(OWNER));
    const other = await walletKeys(OTHER.address, await signFor(OTHER));
    const envelope = await sealBundle(BUNDLE, AGENT, owner);
    await expect(openBundle(envelope, other)).rejects.toThrow(/sealed for 0x/);
  });

  test('a tampered ciphertext, nonce or agent id does not open', async () => {
    const wallet = await walletKeys(OWNER.address, await signFor(OWNER));
    const envelope = await sealBundle(BUNDLE, AGENT, wallet);
    const flipped = fromBase64Url(envelope.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const tampered: Envelope = { ...envelope, ciphertext: toBase64Url(flipped) };
    await expect(openBundle(tampered, wallet)).rejects.toThrow(/could not be opened/);
    await expect(openBundle({ ...envelope, agentId: 'other000000' }, wallet)).rejects.toThrow(/could not be opened/);
    const wrongKey = { ...envelope, key: { ...envelope.key, ciphertext: envelope.key.nonce } };
    await expect(openBundle(wrongKey, wallet)).rejects.toThrow(/could not be opened/);
  });

  test('two seals of the same bundle differ (fresh data key and nonces every time)', async () => {
    const wallet = await walletKeys(OWNER.address, await signFor(OWNER));
    const a = await sealBundle(BUNDLE, AGENT, wallet);
    const b = await sealBundle(BUNDLE, AGENT, wallet);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.key.ciphertext).not.toBe(b.key.ciphertext);
  });
});
