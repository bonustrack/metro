import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { loginUrl } from '../src/api/auth.js';
import { challengeOf, startWebProof, takeWebVerifier } from '../src/auth/sign-in-proof.js';
import { configurePlatform, HOSTED_API, memoryKeyValue } from '../src/platform.js';

const API = 'https://api.example';

beforeEach(() => {
  configurePlatform({ apiBase: API, kv: memoryKeyValue(), tabKv: memoryKeyValue() });
});

afterEach(() => {
  configurePlatform({ kv: memoryKeyValue(), apiBase: HOSTED_API });
});

describe('the web sign-in proof', () => {
  test('a web sign-in sends an S256 challenge and keeps the verifier for this tab, once', () => {
    const challenge = startWebProof();
    const url = new URL(loginUrl('google', 'login', { challenge }));
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('provider')).toBe('google');
    const verifier = takeWebVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier ?? '').digest('base64url'));
    expect(takeWebVerifier()).toBeUndefined();
  });

  test('the challenge is the base64url SHA-256 of the verifier, as the api checks it', () => {
    expect(challengeOf('w'.repeat(43))).toBe(createHash('sha256').update('w'.repeat(43)).digest('base64url'));
  });
});
