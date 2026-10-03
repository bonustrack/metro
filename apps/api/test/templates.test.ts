import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { putTemplate, quickCreateUrl, STACK_NAME, templateKey, templatesOf } from '../src/aws/templates.ts';

type Doc = Record<string, unknown>;

const load = (name: string): Doc => Bun.YAML.parse(readFileSync(new URL(`../cloudformation/${name}`, import.meta.url), 'utf8')) as Doc;
const at = (doc: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((node, key) => (node as Record<string | number, unknown> | undefined)?.[key], doc);

const ACCESS = load('metro-access.yaml');
const IDENTITY = load('metro-identity.yaml');
const statementsOf = (doc: Doc, role: string): Doc[] => at(doc, 'Resources', role, 'Properties', 'Policies', 0, 'PolicyDocument', 'Statement') as Doc[];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the CloudFormation templates', () => {
  test('a connected account gets exactly the server permissions Metro has in its own account', () => {
    const access = statementsOf(ACCESS, 'MetroAccess');
    const own = statementsOf(IDENTITY, 'MetroRole');
    expect(access).toEqual(own.slice(0, 3));
    expect(at(own, 3)).toEqual({ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::*:role/metro-access' });
    expect(at(own, 4, 'Action')).toBe('s3:PutObject');
    expect(at(access, 1, 'Condition')).toEqual({ Null: { 'aws:ResourceTag/metro': 'false' } });
  });

  test("metro-access trusts only Metro's own role, and only with the organization's external id", () => {
    const trust = at(ACCESS, 'Resources', 'MetroAccess', 'Properties', 'AssumeRolePolicyDocument', 'Statement', 0) as Doc;
    expect(trust.Action).toBe('sts:AssumeRole');
    expect(trust.Condition).toEqual({ StringEquals: { 'sts:ExternalId': { Ref: 'ExternalId' } }, ArnEquals: { 'aws:PrincipalArn': { Ref: 'MetroRoleArn' } } });
    expect(at(ACCESS, 'Resources', 'MetroAccess', 'Properties', 'RoleName')).toBe(STACK_NAME);
    expect(at(ACCESS, 'Outputs', 'RoleArn', 'Value')).toEqual({ 'Fn::GetAtt': ['MetroAccess', 'Arn'] });
  });

  test("metro-api is taken only by the Fly app's own token", () => {
    const trust = at(IDENTITY, 'Resources', 'MetroRole', 'Properties', 'AssumeRolePolicyDocument', 'Statement', 0) as Doc;
    expect(trust.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(trust.Condition).toEqual({ StringEquals: { 'oidc.fly.io/stage-labs:aud': 'sts.amazonaws.com' }, StringLike: { 'oidc.fly.io/stage-labs:sub': 'stage-labs:metro:*' } });
    expect(at(IDENTITY, 'Resources', 'FlyProvider', 'Properties', 'Url')).toBe('https://oidc.fly.io/stage-labs');
  });

  test('the link fills in exactly the parameters the template asks for, URL-encoded', () => {
    const url = new URL(quickCreateUrl('https://metro-templates-787391402827.s3.us-east-1.amazonaws.com/metro-access-abc.yaml', { ExternalId: 'ext-abcdefghijklmnop', MetroRoleArn: 'arn:aws:iam::787391402827:role/metro-api' }));
    expect(url.origin).toBe('https://us-east-1.console.aws.amazon.com');
    const [route = '', query = ''] = url.hash.split('?');
    expect(route).toBe('#/stacks/create/review');
    expect(query).toContain('templateURL=https%3A%2F%2Fmetro-templates-787391402827.s3.us-east-1.amazonaws.com%2Fmetro-access-abc.yaml');
    const params = new URLSearchParams(query);
    expect(params.get('stackName')).toBe('metro-access');
    const names = [...params.keys()].filter((k) => k.startsWith('param_')).map((k) => k.slice('param_'.length));
    const declared = Object.keys(at(ACCESS, 'Parameters') as Doc);
    expect(names.every((name) => declared.includes(name))).toBe(true);
    expect(declared.filter((name) => at(ACCESS, 'Parameters', name, 'Default') === undefined).sort()).toEqual([...names].sort());
    expect(params.get('param_MetroRoleArn')).toBe('arn:aws:iam::787391402827:role/metro-api');
  });

  test('the bucket address reads only as a virtual-hosted S3 address', () => {
    expect(templatesOf('https://metro-templates-787391402827.s3.us-east-1.amazonaws.com')).toEqual({
      bucket: 'metro-templates-787391402827',
      region: 'us-east-1',
      base: 'https://metro-templates-787391402827.s3.us-east-1.amazonaws.com',
    });
    expect(templatesOf('https://raw.githubusercontent.com/bonustrack/metro/main/x.yaml')).toBeNull();
    expect(templatesOf('')).toBeNull();
  });

  test('the template is uploaded under a name made of its own hash, signed for S3 with the role session', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof fetch;
    const templates = templatesOf('https://metro-templates-787391402827.s3.us-east-1.amazonaws.com');
    if (templates === null) throw new Error('expected a bucket');
    const key = await templateKey('body');
    expect(key).toMatch(/^metro-access-[0-9a-f]{12}\.yaml$/);
    const url = await putTemplate({ accessKeyId: 'ASIAROLE', secretAccessKey: 's', sessionToken: 'tok' }, templates, key, 'body');
    expect(url).toBe(`https://metro-templates-787391402827.s3.us-east-1.amazonaws.com/${key}`);
    expect(seen[0]?.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]?.headers['x-amz-security-token']).toBe('tok');
    expect(seen[0]?.headers.authorization).toContain('/us-east-1/s3/aws4_request');
    globalThis.fetch = (() => Promise.resolve(new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 }))) as unknown as typeof fetch;
    await expect(putTemplate({ accessKeyId: 'A', secretAccessKey: 's' }, templates, key, 'body')).rejects.toMatchObject({ code: 'AccessDenied', action: 's3:PutObject' });
  });
});
