import { describe, expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { openModelSecret, sealModelSecret, modelSecretOf } from '../src/model-secret.ts';
import { openSecret, sealSecret } from '../src/secrets.ts';

const OWNER = 'org_01TESTOWNER000000';
const ID = 'conn0000001';

function legacySeal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`metro-connector/v1\n${OWNER}\n${ID}`, 'utf8'));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
}

describe('sealing purposes', () => {
  test('a value sealed before purposes existed still opens as a connector secret, never as a model secret', () => {
    const key = randomBytes(32);
    const sealed = legacySeal(key, { kind: 'header', value: 'x' });
    expect(openSecret(key, OWNER, ID, sealed)).toEqual({ kind: 'header', value: 'x' });
    expect(openSecret(key, OWNER, ID, sealed, 'connector')).toEqual({ kind: 'header', value: 'x' });
    expect(() => openSecret(key, OWNER, ID, sealed, 'model')).toThrow('could not be opened');
  });

  test('a model secret opens only as a model secret of its own organization and connection', () => {
    const key = randomBytes(32);
    const row = { owner: OWNER, id: ID, secret: sealModelSecret(key, { owner: OWNER, id: ID }, { kind: 'key', apiKey: 'sk-1' }) };
    expect(openModelSecret(key, row)).toEqual({ kind: 'key', apiKey: 'sk-1' });
    expect(() => openSecret(key, OWNER, ID, row.secret)).toThrow('could not be opened');
    expect(() => openModelSecret(key, { ...row, id: 'conn0000002' })).toThrow('could not be opened');
    expect(() => openModelSecret(key, { ...row, owner: 'org_01TESTSTRANGER00' })).toThrow('could not be opened');
    expect(() => openModelSecret(key, { ...row, secret: sealSecret(key, OWNER, ID, { kind: 'key', apiKey: 'sk-1' }) })).toThrow('could not be opened');
  });

  test('only well-formed shapes read as model secrets', () => {
    const codex = { kind: 'codex', method: 'code', accessToken: 'a', refreshToken: 'r', expiresAt: 1, accountId: 'acct' };
    expect(modelSecretOf(codex)).toEqual(codex);
    expect(modelSecretOf({ ...codex, accountId: undefined })).toBeNull();
    expect(modelSecretOf({ ...codex, method: 'chatgpt' })).toBeNull();
    expect(modelSecretOf({ ...codex, method: 'chatgpt', clientId: 'oaiapp_x' })).toMatchObject({ method: 'chatgpt', clientId: 'oaiapp_x' });
    expect(modelSecretOf({ kind: 'key', apiKey: '' })).toBeNull();
    expect(modelSecretOf({ kind: 'key', apiKey: 'has space' })).toBeNull();
  });
});
