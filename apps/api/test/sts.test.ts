import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountOfRole, assumeRole, assumeRoleWithWebIdentity, callerIdentity } from '../src/aws/sts.ts';
import { flyOidcToken, STS_AUDIENCE } from '../src/aws/fly-oidc.ts';

const CREDS = { accessKeyId: 'ASIABASE', secretAccessKey: 'secret', sessionToken: 'base-token' };
const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

function stub(status: number, xml: string): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: new URLSearchParams(String(init?.body)) });
    return Promise.resolve(new Response(xml, { status, headers: { 'content-type': 'text/xml' } }));
  }) as typeof fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const credentialsXml = (result: string): string =>
  `<${result.replace('Result', 'Response')}><${result}><Credentials><AccessKeyId>ASIANEW</AccessKeyId><SecretAccessKey>new-secret</SecretAccessKey><SessionToken>new-token</SessionToken><Expiration>2026-10-03T23:00:00Z</Expiration></Credentials></${result}></${result.replace('Result', 'Response')}>`;

describe('AWS STS', () => {
  test('AssumeRole is signed with the base keys and carries the external id and the session name', async () => {
    const seen = stub(200, credentialsXml('AssumeRoleResult'));
    const keys = await assumeRole(CREDS, 'arn:aws:iam::111122223333:role/metro-access', 'ext-abcdefghijklmnop', 'metro-conn0000001');
    expect(keys).toEqual({ accessKeyId: 'ASIANEW', secretAccessKey: 'new-secret', sessionToken: 'new-token', expiresAt: Date.parse('2026-10-03T23:00:00Z') });
    expect(seen[0]?.url).toBe('https://sts.us-east-1.amazonaws.com/');
    expect(seen[0]?.headers.authorization).toContain('Credential=ASIABASE/');
    expect(seen[0]?.headers['x-amz-security-token']).toBe('base-token');
    expect(Object.fromEntries(seen[0]?.body ?? [])).toMatchObject({
      Action: 'AssumeRole',
      RoleArn: 'arn:aws:iam::111122223333:role/metro-access',
      ExternalId: 'ext-abcdefghijklmnop',
      RoleSessionName: 'metro-conn0000001',
      DurationSeconds: '3600',
    });
  });

  test('AssumeRoleWithWebIdentity goes out unsigned, with the Fly token', async () => {
    const seen = stub(200, credentialsXml('AssumeRoleWithWebIdentityResult'));
    const keys = await assumeRoleWithWebIdentity('arn:aws:iam::787391402827:role/metro-api', 'a.b.c', 'metro-api');
    expect(keys.accessKeyId).toBe('ASIANEW');
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(seen[0]?.body ?? [])).toMatchObject({ Action: 'AssumeRoleWithWebIdentity', WebIdentityToken: 'a.b.c', RoleSessionName: 'metro-api' });
  });

  test("a refusal keeps AWS's own words, and an answer without keys is an error", async () => {
    stub(403, '<ErrorResponse><Error><Code>AccessDenied</Code><Message>not authorized to perform sts:AssumeRole</Message></Error></ErrorResponse>');
    await expect(assumeRole(CREDS, 'arn:aws:iam::111122223333:role/metro-access', 'ext-abcdefghijklmnop', 's')).rejects.toMatchObject({ code: 'AccessDenied', action: 'sts:AssumeRole' });
    stub(200, '<AssumeRoleResponse><AssumeRoleResult></AssumeRoleResult></AssumeRoleResponse>');
    await expect(assumeRole(CREDS, 'arn:aws:iam::111122223333:role/metro-access', 'ext-abcdefghijklmnop', 's')).rejects.toMatchObject({ code: 'NoCredentials' });
  });

  test('GetCallerIdentity names the account and the session', async () => {
    stub(200, '<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:sts::111122223333:assumed-role/metro-access/metro-x</Arn><Account>111122223333</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
    expect(await callerIdentity(() => Promise.resolve(CREDS))).toEqual({ account: '111122223333', arn: 'arn:aws:sts::111122223333:assumed-role/metro-access/metro-x' });
  });

  test('the account of a role comes from its ARN, and anything else is not a role', () => {
    expect(accountOfRole('arn:aws:iam::111122223333:role/metro-access')).toBe('111122223333');
    expect(accountOfRole('arn:aws:iam::111122223333:user/metro')).toBeNull();
    expect(accountOfRole('arn:aws:iam::1111:role/metro-access')).toBeNull();
  });
});

describe('the Fly token', () => {
  let dir = '';
  let socket = '';
  let answer: { status: number; body: string } = { status: 200, body: 'aaa.bbb.ccc' };
  let asked: string[] = [];
  let server: Server;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fly-oidc-'));
    socket = join(dir, 'api.sock');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (part: Buffer) => {
        body += part.toString();
      });
      req.on('end', () => {
        asked.push(`${req.method ?? ''} ${req.url ?? ''} ${body}`);
        res.writeHead(answer.status).end(answer.body);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(socket, resolve);
    });
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('comes from the machine API socket, for the STS audience', async () => {
    answer = { status: 200, body: 'aaa.bbb.ccc\n' };
    asked = [];
    expect(await flyOidcToken(STS_AUDIENCE, socket)).toBe('aaa.bbb.ccc');
    expect(asked).toEqual(['POST /v1/tokens/oidc {"aud":"sts.amazonaws.com"}']);
  });

  test('a refusal, an answer that is not a token, or no socket at all is an error that says why', async () => {
    answer = { status: 403, body: 'denied' };
    await expect(flyOidcToken(STS_AUDIENCE, socket)).rejects.toThrow('answered 403 denied');
    answer = { status: 200, body: '{"token":"x"}' };
    await expect(flyOidcToken(STS_AUDIENCE, socket)).rejects.toThrow('not a token');
    await expect(flyOidcToken(STS_AUDIENCE, join(dir, 'none.sock'))).rejects.toThrow('only when it runs on Fly');
  });
});
