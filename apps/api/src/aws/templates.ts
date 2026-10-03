import { readFile } from 'node:fs/promises';
import { errMsg, log } from '@metro-labs/core/log';
import { sha256Hex, signV4 } from '@metro-labs/http/sigv4';
import { AwsError, keysOf, type AwsCredentials } from './ec2.js';
import { parseXml, textAt } from './xml.js';

export const STACK_NAME = 'metro-access';
const TEMPLATE_FILE = new URL('../../cloudformation/metro-access.yaml', import.meta.url);
const TEMPLATES_RE = /^https:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com\/?$/;
const CONSOLE_REGION = 'us-east-1';
const YAML_TYPE = 'application/x-yaml';

export interface Templates {
  bucket: string;
  region: string;
  base: string;
}

export interface StackParams {
  ExternalId: string;
  MetroRoleArn: string;
}

export function templatesOf(raw: string): Templates | null {
  const match = TEMPLATES_RE.exec(raw.trim());
  if (match === null) return null;
  const [, bucket = '', region = ''] = match;
  return { bucket, region, base: `https://${bucket}.s3.${region}.amazonaws.com` };
}

export const templateKey = async (body: string): Promise<string> => `${STACK_NAME}-${(await sha256Hex(body)).slice(0, 12)}.yaml`;

export function quickCreateUrl(templateUrl: string, params: StackParams): string {
  const query = new URLSearchParams({
    templateURL: templateUrl,
    stackName: STACK_NAME,
    ...Object.fromEntries(Object.entries(params).map(([name, value]) => [`param_${name}`, value])),
  });
  return `https://${CONSOLE_REGION}.console.aws.amazon.com/cloudformation/home?region=${CONSOLE_REGION}#/stacks/create/review?${query.toString()}`;
}

export async function putTemplate(credentials: AwsCredentials, templates: Templates, key: string, body: string): Promise<string> {
  const url = `${templates.base}/${key}`;
  const signed = await signV4({
    method: 'PUT',
    url,
    headers: { 'content-type': YAML_TYPE, 'x-amz-content-sha256': await sha256Hex(body) },
    body,
    region: templates.region,
    service: 's3',
    ...(await keysOf(credentials)),
  });
  let res: Response;
  try {
    res = await fetch(url, { method: 'PUT', headers: signed.headers, body });
  } catch {
    throw new AwsError('Unreachable', `Could not reach the bucket ${templates.bucket}.`, 's3:PutObject');
  }
  if (res.ok) return url;
  const xml = parseXml(await res.text());
  throw new AwsError(textAt(xml, 'Code') || `HTTP${String(res.status)}`, textAt(xml, 'Message') || `The bucket ${templates.bucket} answered ${String(res.status)}.`, 's3:PutObject');
}

const published = new Map<string, Promise<string>>();

export function publishTemplate(credentials: AwsCredentials, templates: Templates): Promise<string> {
  const held = published.get(templates.base);
  if (held !== undefined) return held;
  const work = (async () => {
    const body = await readFile(TEMPLATE_FILE, 'utf8');
    return putTemplate(credentials, templates, await templateKey(body), body);
  })();
  published.set(templates.base, work);
  work.catch((err: unknown) => {
    if (published.get(templates.base) === work) published.delete(templates.base);
    log.warn({ bucket: templates.bucket, err: errMsg(err) }, 'aws: could not publish the metro-access template');
  });
  return work;
}
