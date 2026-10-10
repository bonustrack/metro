import { beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { AwsError } from '../src/aws/ec2.ts';
import { connectorAad, dataKeyAad, openWith, sealWith } from '../src/connectors/envelope.ts';
import { Keyring, type ConnectorKeyRow, type ConnectorKeyStore } from '../src/connectors/keyring.ts';
import { kmsWrapper, localWrapper } from '../src/connectors/key-wrappers.ts';
import { decryptDataKey, generateDataKey, kmsRegion, type KmsFetch, type KmsKey } from '../src/connectors/kms.ts';
import { readConnectorsSetup } from '../src/connectors/setup.ts';

const ARN = 'arn:aws:kms:us-east-1:787391402827:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const OWNER = 'org_01TESTOWNER000000';
const ROLE = 'arn:aws:iam::787391402827:role/metro-api';
const KEYS = { accessKeyId: 'ASIAMETRO', secretAccessKey: 'secret-fixture', sessionToken: 'session-fixture' };

interface KmsCall {
  url: string;
  target: string;
  authorization: string;
  token: string;
  body: Record<string, unknown>;
}

let calls: KmsCall[] = [];
let answer: ((call: KmsCall) => Response) | null = null;
const master = randomBytes(32);

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/x-amz-json-1.1' } });

function fakeKms(call: KmsCall): Response {
  const context = JSON.stringify(call.body.EncryptionContext);
  if (call.target === 'TrentService.GenerateDataKey') {
    const plain = randomBytes(32);
    const blob = Buffer.from(sealWith(master, context, plain)).toString('base64');
    return json(200, { KeyId: ARN, Plaintext: plain.toString('base64'), CiphertextBlob: blob });
  }
  try {
    const plain = openWith(master, context, Buffer.from(String(call.body.CiphertextBlob), 'base64').toString('utf8'));
    return json(200, { KeyId: ARN, Plaintext: plain.toString('base64') });
  } catch {
    return json(400, { __type: 'com.amazonaws.kms#InvalidCiphertextException', message: 'The ciphertext is invalid.' });
  }
}

const kmsFetch: KmsFetch = async (url, init) => {
  const headers = new Headers(init.headers);
  const call: KmsCall = {
    url,
    target: headers.get('x-amz-target') ?? '',
    authorization: headers.get('authorization') ?? '',
    token: headers.get('x-amz-security-token') ?? '',
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
  calls.push(call);
  return Promise.resolve((answer ?? fakeKms)(call));
};

const kmsKey: KmsKey = { arn: ARN, region: 'us-east-1', credentials: () => Promise.resolve(KEYS), fetch: kmsFetch };

function memoryStore(): ConnectorKeyStore & { rows: Map<string, ConnectorKeyRow> } {
  const rows = new Map<string, ConnectorKeyRow>();
  const store = {
    rows,
    find: (owner: string) => Promise.resolve(rows.get(owner) ?? null),
    insert: (row: ConnectorKeyRow) => {
      if (!rows.has(row.owner)) rows.set(row.owner, row);
      return Promise.resolve();
    },
  };
  return store;
}

beforeEach(() => {
  calls = [];
  answer = null;
});

describe('the envelope', () => {
  test('a sealed value is bound to its organization and connector', () => {
    const key = randomBytes(32);
    const sealed = sealWith(key, connectorAad(OWNER, 'conn0000001'), Buffer.from('secret'));
    expect(openWith(key, connectorAad(OWNER, 'conn0000001'), sealed).toString()).toBe('secret');
    expect(() => openWith(key, connectorAad(OWNER, 'conn0000002'), sealed)).toThrow('could not be opened');
    expect(() => openWith(key, dataKeyAad(OWNER), sealed)).toThrow('could not be opened');
    expect(() => openWith(randomBytes(32), connectorAad(OWNER, 'conn0000001'), sealed)).toThrow('could not be opened');
  });

  test('a changed byte, a cut tag or another format is refused', () => {
    const key = randomBytes(32);
    const aad = connectorAad(OWNER, 'conn0000001');
    const sealed = sealWith(key, aad, Buffer.from('secret'));
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    for (const bad of [`v1.${raw.toString('base64url')}`, `v1.${Buffer.from(sealed.slice(3), 'base64url').subarray(0, 20).toString('base64url')}`, sealed.replace('v1.', 'v2.'), `${sealed}.x`, 'v1.!!'])
      expect(() => openWith(key, aad, bad)).toThrow('could not be opened');
    expect(() => sealWith(randomBytes(16), aad, Buffer.from('x'))).toThrow('32 bytes');
  });
});

describe('KMS', () => {
  test('GenerateDataKey and Decrypt are signed for KMS and carry the organization as encryption context', async () => {
    const made = await generateDataKey(kmsKey, { 'metro:organization': OWNER, 'metro:purpose': 'connectors' });
    const back = await decryptDataKey(kmsKey, made.wrapped, { 'metro:organization': OWNER, 'metro:purpose': 'connectors' });
    expect(back.equals(made.plain)).toBe(true);
    expect(calls.map((call) => call.target)).toEqual(['TrentService.GenerateDataKey', 'TrentService.Decrypt']);
    for (const call of calls) {
      expect(call.url).toBe('https://kms.us-east-1.amazonaws.com/');
      expect(call.authorization).toStartWith('AWS4-HMAC-SHA256 Credential=ASIAMETRO/');
      expect(call.authorization).toContain('/us-east-1/kms/aws4_request');
      expect(call.authorization).toContain('x-amz-target');
      expect(call.token).toBe('session-fixture');
      expect(call.body.KeyId).toBe(ARN);
      expect(call.body.EncryptionContext).toEqual({ 'metro:organization': OWNER, 'metro:purpose': 'connectors' });
    }
    expect(calls[0]?.body.KeySpec).toBe('AES_256');
    expect(calls[1]?.body.CiphertextBlob).toBe(made.wrapped);
  });

  test('a refusal, another key or a bad data key is an AWS error', async () => {
    answer = () => json(400, { __type: 'com.amazon.coral.service#AccessDeniedException', message: 'not authorized to perform kms:GenerateDataKey' });
    await expect(generateDataKey(kmsKey, {})).rejects.toMatchObject({ code: 'AccessDeniedException', action: 'kms:GenerateDataKey' });
    answer = () => json(200, { KeyId: 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab', Plaintext: randomBytes(32).toString('base64'), CiphertextBlob: 'AAAA' });
    await expect(generateDataKey(kmsKey, {})).rejects.toMatchObject({ code: 'WrongKey' });
    answer = () => json(200, { KeyId: ARN, Plaintext: randomBytes(16).toString('base64'), CiphertextBlob: 'AAAA' });
    await expect(generateDataKey(kmsKey, {})).rejects.toMatchObject({ code: 'BadAnswer' });
    const down: KmsKey = { ...kmsKey, fetch: () => Promise.reject(new Error('offline')) };
    await expect(decryptDataKey(down, 'AAAA', {})).rejects.toBeInstanceOf(AwsError);
  });

  test('a key ARN names its region, an alias or another service does not', () => {
    expect(kmsRegion(ARN)).toBe('us-east-1');
    expect(kmsRegion('arn:aws:kms:eu-central-2:787391402827:key/mrk-0123456789abcdef0123456789abcdef')).toBe('eu-central-2');
    expect(kmsRegion('arn:aws:kms:us-east-1:787391402827:alias/metro-connectors')).toBeNull();
    expect(kmsRegion('arn:aws:iam::787391402827:role/metro-api')).toBeNull();
  });
});

describe('the keyring', () => {
  test('one data key per organization, made once, then read from the cache', async () => {
    const store = memoryStore();
    const keyring = new Keyring({ wrapper: kmsWrapper(kmsKey), store, now: () => 0 });
    const sealed = await Promise.all([keyring.seal(OWNER, 'conn0000001', 'a'), keyring.seal(OWNER, 'conn0000002', 'b')]);
    expect(await keyring.open(OWNER, 'conn0000001', sealed[0] ?? '')).toBe('a');
    expect(calls.map((call) => call.target)).toEqual(['TrentService.GenerateDataKey']);
    expect(store.rows.get(OWNER)?.wrapping).toBe(`kms:${ARN}`);
  });

  test('a cold keyring unwraps through KMS, and again once the cache expires', async () => {
    const store = memoryStore();
    let now = 0;
    const sealed = await new Keyring({ wrapper: kmsWrapper(kmsKey), store, now: () => now }).seal(OWNER, 'conn0000001', { token: 'x' });
    calls = [];
    const cold = new Keyring({ wrapper: kmsWrapper(kmsKey), store, now: () => now });
    expect(await cold.open(OWNER, 'conn0000001', sealed)).toEqual({ token: 'x' });
    expect(await cold.open(OWNER, 'conn0000001', sealed)).toEqual({ token: 'x' });
    now = 5 * 60_000 + 1;
    expect(await cold.open(OWNER, 'conn0000001', sealed)).toEqual({ token: 'x' });
    expect(calls.map((call) => call.target)).toEqual(['TrentService.Decrypt', 'TrentService.Decrypt']);
  });

  test('when another machine kept its key first, that key wins', async () => {
    const store = memoryStore();
    const wrapper = localWrapper(randomBytes(32));
    const first = new Keyring({ wrapper, store, now: () => 0 });
    const winner = await first.seal(OWNER, 'conn0000001', 'first');
    const kept = store.rows.get(OWNER);
    let raced = false;
    const racing: ConnectorKeyStore = {
      find: (owner) => {
        if (raced) return store.find(owner);
        raced = true;
        return Promise.resolve(null);
      },
      insert: (row) => store.insert(row),
    };
    const second = new Keyring({ wrapper, store: racing, now: () => 0 });
    expect(await second.open(OWNER, 'conn0000001', winner)).toBe('first');
    expect(raced).toBe(true);
    expect(store.rows.get(OWNER)).toBe(kept);
  });

  test('a value too large to keep is refused', async () => {
    const keyring = new Keyring({ wrapper: localWrapper(randomBytes(32)), store: memoryStore(), now: () => 0 });
    await expect(keyring.seal(OWNER, 'conn0000001', 'x'.repeat(70_000))).rejects.toThrow('too large');
  });
});

describe('the switch', () => {
  const never = { role: () => { throw new Error('no AWS role should be read'); }, fetch: () => Promise.reject(new Error('no KMS call should be made')) };

  test('off unless METRO_CONNECTORS_ENABLED is true, and then nothing reaches AWS', () => {
    expect(readConnectorsSetup({}, never)).toMatchObject({ enabled: false, wrapper: null });
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: '1', METRO_CONNECTORS_KMS_KEY: ARN, METRO_AWS_ROLE_ARN: ROLE }, never)).toMatchObject({ enabled: false, wrapper: null });
  });

  test('KMS when its key and Metro role are set, without calling KMS yet', () => {
    const roles: string[] = [];
    const setup = readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_KMS_KEY: ARN, METRO_AWS_ROLE_ARN: ROLE, METRO_CONNECTORS_LOCAL_KEY: 'ab'.repeat(32) }, { role: (role) => { roles.push(role); return KEYS; }, fetch: never.fetch });
    expect(setup).toMatchObject({ enabled: true });
    expect(setup.wrapper?.id).toBe(`kms:${ARN}`);
    expect(roles).toEqual([ROLE]);
    expect(calls).toEqual([]);
  });

  test('no wrapping key means no connector secret, with a reason', () => {
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true' }, never)).toMatchObject({ enabled: true, wrapper: null });
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_KMS_KEY: 'alias/metro' }, never).note).toContain('not a KMS key ARN');
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_KMS_KEY: ARN }, never).note).toContain('METRO_AWS_ROLE_ARN');
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_LOCAL_KEY: 'xyz' }, never).wrapper).toBeNull();
  });

  test('the local key is for development and tests, never on Fly', () => {
    const local = { METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_LOCAL_KEY: 'ab'.repeat(32) };
    expect(readConnectorsSetup(local, never).wrapper?.id).toStartWith('local:');
    const onFly = readConnectorsSetup({ ...local, FLY_APP_NAME: 'metro' }, never);
    expect(onFly.wrapper).toBeNull();
    expect(onFly.note).toContain('ignored on Fly');
  });
});
