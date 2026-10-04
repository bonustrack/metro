import { describe, expect, test } from 'bun:test';
import { gcm } from '@noble/ciphers/aes';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { gunzipSync } from 'fflate';
import { gzipBytes, openBytes, sealBytes, sha256Hex, type Sealing } from '../src/export/primitives.ts';

const sealing: Sealing = { passphrase: 'correct horse', salt: new Uint8Array(16).fill(7), iterations: 1000, nonce: new Uint8Array(12).fill(3), aad: new TextEncoder().encode('agent0000001') };

describe('the .metro sealing works the same with or without WebCrypto', () => {
  test('a file sealed with WebCrypto opens with the pure JS fallback, and back', async () => {
    const plain = new TextEncoder().encode('{"hello":"metro"}');
    const sealed = await sealBytes(sealing, plain);
    const key = await pbkdf2Async(sha256, new TextEncoder().encode(sealing.passphrase), sealing.salt, { c: sealing.iterations, dkLen: 32 });
    expect(new TextDecoder().decode(gcm(key, sealing.nonce, sealing.aad).decrypt(sealed))).toBe('{"hello":"metro"}');
    const byFallback = gcm(key, sealing.nonce, sealing.aad).encrypt(plain);
    expect(new TextDecoder().decode(await openBytes(sealing, byFallback))).toBe('{"hello":"metro"}');
  });

  test('the digest and the gzip match their pure JS counterparts', async () => {
    expect(await sha256Hex('metro')).toBe([...sha256(new TextEncoder().encode('metro'))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    expect(new TextDecoder().decode(gunzipSync(await gzipBytes(new TextEncoder().encode('metro metro metro'))))).toBe('metro metro metro');
  });
});
