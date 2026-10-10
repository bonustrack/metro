import { isRecord } from '@metro-labs/core/is-record';
import { signV4 } from '@metro-labs/http/sigv4';
import { AwsError, keysOf, type AwsCredentials } from '../aws/ec2.js';

export const KMS_KEY_RE = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const CONTENT_TYPE = 'application/x-amz-json-1.1';
const TIMEOUT_MS = 10_000;
const DATA_KEY_BYTES = 32;
const BLOB_MAX = 6144;

export type KmsFetch = (url: string, init: RequestInit) => Promise<Response>;

export type KmsContext = Record<string, string>;

export interface KmsKey {
  arn: string;
  region: string;
  credentials: AwsCredentials;
  fetch: KmsFetch;
}

export function kmsRegion(arn: string): string | null {
  return KMS_KEY_RE.exec(arn)?.[1] ?? null;
}

function failureOf(action: string, status: number, value: unknown): AwsError {
  const type = isRecord(value) && typeof value.__type === 'string' ? value.__type.split('#').pop() ?? '' : '';
  const message = isRecord(value) && typeof value.message === 'string' ? value.message : '';
  return new AwsError(type === '' ? `HTTP${String(status)}` : type, message === '' ? `KMS answered ${String(status)}.` : message, `kms:${action}`);
}

async function kmsCall(key: KmsKey, action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `https://kms.${key.region}.amazonaws.com/`;
  const body = JSON.stringify(payload);
  const signed = await signV4({
    method: 'POST',
    url,
    headers: { 'content-type': CONTENT_TYPE, 'x-amz-target': `TrentService.${action}` },
    body,
    region: key.region,
    service: 'kms',
    ...(await keysOf(key.credentials)),
  });
  let res: Response;
  try {
    res = await key.fetch(url, { method: 'POST', headers: signed.headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AwsError('Unreachable', `Could not reach KMS in ${key.region}.`, `kms:${action}`);
  }
  const value: unknown = await res.json().catch(() => null);
  if (!res.ok) throw failureOf(action, res.status, value);
  if (!isRecord(value)) throw new AwsError('BadAnswer', 'KMS sent an answer Metro cannot read.', `kms:${action}`);
  if (value.KeyId !== key.arn) throw new AwsError('WrongKey', 'KMS answered with another key than the one Metro uses for connectors.', `kms:${action}`);
  return value;
}

function bytesOf(value: unknown, action: string): Buffer {
  if (typeof value !== 'string' || value.length > BLOB_MAX) throw new AwsError('BadAnswer', 'KMS sent an answer Metro cannot read.', `kms:${action}`);
  return Buffer.from(value, 'base64');
}

function dataKeyOf(value: unknown, action: string): Buffer {
  const key = bytesOf(value, action);
  if (key.length !== DATA_KEY_BYTES) throw new AwsError('BadAnswer', 'KMS answered with a data key of the wrong size.', `kms:${action}`);
  return key;
}

export async function generateDataKey(key: KmsKey, context: KmsContext): Promise<{ plain: Buffer; wrapped: string }> {
  const value = await kmsCall(key, 'GenerateDataKey', { KeyId: key.arn, KeySpec: 'AES_256', EncryptionContext: context });
  const plain = dataKeyOf(value.Plaintext, 'GenerateDataKey');
  const wrapped = bytesOf(value.CiphertextBlob, 'GenerateDataKey');
  if (wrapped.length === 0) throw new AwsError('BadAnswer', 'KMS answered without the wrapped data key.', 'kms:GenerateDataKey');
  return { plain, wrapped: wrapped.toString('base64') };
}

export async function decryptDataKey(key: KmsKey, wrapped: string, context: KmsContext): Promise<Buffer> {
  const value = await kmsCall(key, 'Decrypt', { KeyId: key.arn, CiphertextBlob: wrapped, EncryptionContext: context });
  return dataKeyOf(value.Plaintext, 'Decrypt');
}
