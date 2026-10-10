import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  BOX_CLOCK_SKEW_MS,
  boxKeyId,
  boxSignatureValid,
  rawPublicKey,
  readBoxProof,
  sealingKeyOf,
  signBoxRequest,
  signingKeyOf,
  withinSkew,
  type BoxRequest,
} from '../src/box-signature.ts';

const pair = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const signingKey = rawPublicKey(pair.publicKey);
const keyId = boxKeyId(signingKey);
const NOW = 1_791_590_000_000;

const request = (overrides: Partial<BoxRequest> = {}): BoxRequest => ({
  method: 'POST',
  host: 'api.metro.box',
  path: '/api/boxes/enroll',
  body: Buffer.from('{"ticket":"x"}'),
  ...overrides,
});

const signed = (req: BoxRequest = request()): string => signBoxRequest(req, pair.privateKey, keyId, NOW);

describe('box request signatures', () => {
  test('a signed request verifies with the box key and no other', () => {
    const proof = readBoxProof(signed());
    expect(proof).not.toBeNull();
    if (proof === null) return;
    expect(proof).toMatchObject({ keyId, time: NOW });
    expect(boxSignatureValid(request(), proof, signingKey)).toBe(true);
    expect(boxSignatureValid(request(), proof, rawPublicKey(other.publicKey))).toBe(false);
  });

  test('every signed part is bound: method, host, path, body', () => {
    const proof = readBoxProof(signed());
    if (proof === null) throw new Error('no proof');
    for (const changed of [
      request({ method: 'GET' }),
      request({ host: 'staging.api.metro.box' }),
      request({ path: '/api/boxes/session' }),
      request({ body: Buffer.from('{"ticket":"y"}') }),
    ]) expect(boxSignatureValid(changed, proof, signingKey)).toBe(false);
  });

  test('the time, nonce and key id are signed too', () => {
    const proof = readBoxProof(signed());
    if (proof === null) throw new Error('no proof');
    expect(boxSignatureValid(request(), { ...proof, time: NOW + 1 }, signingKey)).toBe(false);
    expect(boxSignatureValid(request(), { ...proof, nonce: 'A'.repeat(22) }, signingKey)).toBe(false);
    expect(boxSignatureValid(request(), { ...proof, keyId: boxKeyId(rawPublicKey(other.publicKey)) }, signingKey)).toBe(false);
  });

  test('each request gets a fresh nonce', () => {
    const first = readBoxProof(signed());
    const second = readBoxProof(signed());
    expect(first?.nonce).not.toBe(second?.nonce);
  });

  test('malformed headers read as no proof', () => {
    const good = signed();
    for (const header of [
      undefined,
      '',
      good.replace('MetroBox', 'Bearer'),
      `${good} extra`,
      `${good}.extra`,
      good.replace(`.${String(NOW)}.`, '.12x.'),
      `MetroBox ${'a'.repeat(300)}`,
    ]) expect(readBoxProof(header)).toBeNull();
  });

  test('raw public keys are checked per curve', () => {
    const sealing = rawPublicKey(generateKeyPairSync('x25519').publicKey);
    expect(signingKeyOf(signingKey)).not.toBeNull();
    expect(sealingKeyOf(sealing)).not.toBeNull();
    expect(signingKeyOf('short')).toBeNull();
    expect(signingKeyOf(`${signingKey.slice(0, 42)}=`)).toBeNull();
    expect(sealingKeyOf('A'.repeat(43))).toBeNull();
    expect(boxSignatureValid(request(), { keyId, time: NOW, nonce: 'A'.repeat(22), signature: 'A'.repeat(86) }, 'not-a-key')).toBe(false);
  });

  test('the clock window is five minutes each way', () => {
    expect(withinSkew(NOW, NOW + BOX_CLOCK_SKEW_MS)).toBe(true);
    expect(withinSkew(NOW, NOW - BOX_CLOCK_SKEW_MS)).toBe(true);
    expect(withinSkew(NOW, NOW + BOX_CLOCK_SKEW_MS + 1)).toBe(false);
    expect(withinSkew(NOW, NOW - BOX_CLOCK_SKEW_MS - 1)).toBe(false);
  });
});
