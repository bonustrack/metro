import { awsQuery, AwsError, unsignedQuery, type AwsCredentials, type AwsKeys, type QueryService } from './ec2.js';
import { child, textAt, type XmlNode } from './xml.js';

const STS: QueryService = { host: 'sts.us-east-1.amazonaws.com', region: 'us-east-1', signingName: 'sts', iamPrefix: 'sts', version: '2011-06-15', label: 'AWS STS' };
const SESSION_SECONDS = '3600';

export const ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/;

export interface RoleKeys extends AwsKeys {
  sessionToken: string;
  expiresAt: number;
}

export interface Caller {
  account: string;
  arn: string;
}

export const accountOfRole = (roleArn: string): string | null => ROLE_ARN_RE.exec(roleArn)?.[1] ?? null;

function keysIn(xml: XmlNode, result: string, roleArn: string, action: string): RoleKeys {
  const found = child(child(xml, result), 'Credentials');
  const keys = {
    accessKeyId: textAt(found, 'AccessKeyId'),
    secretAccessKey: textAt(found, 'SecretAccessKey'),
    sessionToken: textAt(found, 'SessionToken'),
    expiresAt: Date.parse(textAt(found, 'Expiration')),
  };
  if (keys.accessKeyId === '' || keys.secretAccessKey === '' || keys.sessionToken === '' || !Number.isFinite(keys.expiresAt))
    throw new AwsError('NoCredentials', `AWS STS answered without credentials for ${roleArn}.`, action);
  return keys;
}

export async function assumeRole(base: AwsCredentials, roleArn: string, externalId: string, sessionName: string): Promise<RoleKeys> {
  const xml = await awsQuery(base, STS, 'AssumeRole', { RoleArn: roleArn, RoleSessionName: sessionName, ExternalId: externalId, DurationSeconds: SESSION_SECONDS });
  return keysIn(xml, 'AssumeRoleResult', roleArn, 'sts:AssumeRole');
}

export async function assumeRoleWithWebIdentity(roleArn: string, token: string, sessionName: string): Promise<RoleKeys> {
  const xml = await unsignedQuery(STS, 'AssumeRoleWithWebIdentity', { RoleArn: roleArn, RoleSessionName: sessionName, WebIdentityToken: token, DurationSeconds: SESSION_SECONDS });
  return keysIn(xml, 'AssumeRoleWithWebIdentityResult', roleArn, 'sts:AssumeRoleWithWebIdentity');
}

export async function callerIdentity(credentials: AwsCredentials): Promise<Caller> {
  const xml = await awsQuery(credentials, STS, 'GetCallerIdentity', {});
  const result = child(xml, 'GetCallerIdentityResult');
  return { account: textAt(result, 'Account'), arn: textAt(result, 'Arn') };
}
