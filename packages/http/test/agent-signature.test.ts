import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  AGENT_CLOCK_SKEW_MS,
  agentKeyId,
  agentSignatureValid,
  rawPublicKey,
  readAgentProof,
  signAgentRequest,
  signingKeyOf,
  withinSkew,
  type AgentRequest,
} from '../src/agent-signature.ts';

const pair = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const signingKey = rawPublicKey(pair.publicKey);
const keyId = agentKeyId(signingKey);
const NOW = 1_791_590_000_000;

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  method: 'POST',
  host: 'api.metro.box',
  path: '/api/agents/enroll',
  body: Buffer.from('{"ticket":"x"}'),
  ...overrides,
});

const signed = (req: AgentRequest = request()): string => signAgentRequest(req, pair.privateKey, keyId, NOW);

describe('agent request signatures', () => {
  test('a signed request verifies with the agent key and no other', () => {
    const proof = readAgentProof(signed());
    expect(proof).not.toBeNull();
    if (proof === null) return;
    expect(proof).toMatchObject({ keyId, time: NOW });
    expect(agentSignatureValid(request(), proof, signingKey)).toBe(true);
    expect(agentSignatureValid(request(), proof, rawPublicKey(other.publicKey))).toBe(false);
  });

  test('uses the agent scheme and signing domain, never the legacy box domain', () => {
    const header = signed();
    expect(header.startsWith('MetroAgent ')).toBe(true);
    const proof = readAgentProof(header);
    if (proof === null) throw new Error('no proof');
    const req = request();
    const input = (domain: string): Buffer => Buffer.from([domain, req.method, req.host, req.path, proof.keyId, String(proof.time), proof.nonce, createHash('sha256').update(req.body).digest('base64url')].join('\n'));
    expect(sign(null, input('metro-agent-request/v1'), pair.privateKey).toString('base64url')).toBe(proof.signature);
    const legacy = sign(null, input('metro-box-request/v1'), pair.privateKey).toString('base64url');
    expect(agentSignatureValid(req, { ...proof, signature: legacy }, signingKey)).toBe(false);
  });

  test('every signed part is bound: method, host, path, body', () => {
    const proof = readAgentProof(signed());
    if (proof === null) throw new Error('no proof');
    for (const changed of [
      request({ method: 'GET' }),
      request({ host: 'staging.api.metro.box' }),
      request({ path: '/api/agents/session' }),
      request({ body: Buffer.from('{"ticket":"y"}') }),
    ]) expect(agentSignatureValid(changed, proof, signingKey)).toBe(false);
  });

  test('the time, nonce and key id are signed too', () => {
    const proof = readAgentProof(signed());
    if (proof === null) throw new Error('no proof');
    expect(agentSignatureValid(request(), { ...proof, time: NOW + 1 }, signingKey)).toBe(false);
    expect(agentSignatureValid(request(), { ...proof, nonce: 'A'.repeat(22) }, signingKey)).toBe(false);
    expect(agentSignatureValid(request(), { ...proof, keyId: agentKeyId(rawPublicKey(other.publicKey)) }, signingKey)).toBe(false);
  });

  test('each request gets a fresh nonce', () => {
    const first = readAgentProof(signed());
    const second = readAgentProof(signed());
    expect(first?.nonce).not.toBe(second?.nonce);
  });

  test('malformed headers read as no proof', () => {
    const good = signed();
    for (const header of [
      undefined,
      '',
      good.replace('MetroAgent', 'Bearer'),
      good.replace('MetroAgent', 'MetroBox'),
      `${good} extra`,
      `${good}.extra`,
      good.replace(`.${String(NOW)}.`, '.12x.'),
      `MetroAgent ${'a'.repeat(300)}`,
    ]) expect(readAgentProof(header)).toBeNull();
  });

  test('raw signing keys are checked', () => {
    expect(signingKeyOf(signingKey)).not.toBeNull();
    expect(signingKeyOf('short')).toBeNull();
    expect(signingKeyOf(`${signingKey.slice(0, 42)}=`)).toBeNull();
    expect(agentSignatureValid(request(), { keyId, time: NOW, nonce: 'A'.repeat(22), signature: 'A'.repeat(86) }, 'not-a-key')).toBe(false);
  });

  test('the clock window is five minutes each way', () => {
    expect(withinSkew(NOW, NOW + AGENT_CLOCK_SKEW_MS)).toBe(true);
    expect(withinSkew(NOW, NOW - AGENT_CLOCK_SKEW_MS)).toBe(true);
    expect(withinSkew(NOW, NOW + AGENT_CLOCK_SKEW_MS + 1)).toBe(false);
    expect(withinSkew(NOW, NOW - AGENT_CLOCK_SKEW_MS - 1)).toBe(false);
  });

  test('a small-order or non-canonical signing key is refused, so the forged signature it allows never counts', () => {
    const weak = [
      '0100000000000000000000000000000000000000000000000000000000000000',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000080',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ].map((hex) => Buffer.from(hex, 'hex').toString('base64url'));
    for (const key of weak) expect(signingKeyOf(key)).toBeNull();
    const identity = weak[0] ?? '';
    const forged = { keyId: agentKeyId(identity), time: NOW, nonce: 'A'.repeat(22), signature: Buffer.concat([Buffer.from(identity, 'base64url'), Buffer.alloc(32)]).toString('base64url') };
    expect(agentSignatureValid(request(), forged, identity)).toBe(false);
    for (let i = 0; i < 50; i += 1) expect(signingKeyOf(rawPublicKey(generateKeyPairSync('ed25519').publicKey))).not.toBeNull();
  });
});
