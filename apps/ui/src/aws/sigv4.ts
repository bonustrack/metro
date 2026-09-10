const enc = new TextEncoder();

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data)));
}

const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const byPair = (a: [string, string], b: [string, string]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  url.searchParams.forEach((value, key) => {
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  });
  return pairs.sort(byPair).map(([k, v]) => `${k}=${v}`).join('&');
}

export const amzDate = (date: Date): string =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date?: Date;
}

export interface Signed {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function canonicalHeaders(input: SignInput, url: URL, date: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) out[key.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  out.host = url.host;
  out['x-amz-date'] = date;
  return out;
}

async function signingKey(input: SignInput, day: string): Promise<Uint8Array<ArrayBuffer>> {
  const kDate = await hmac(enc.encode(`AWS4${input.secretAccessKey}`), day);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  return hmac(kService, 'aws4_request');
}

export async function signV4(input: SignInput): Promise<Signed> {
  const url = new URL(input.url);
  const date = amzDate(input.date ?? new Date());
  const day = date.slice(0, 8);
  const headers = canonicalHeaders(input, url, date);
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname === '' ? '/' : url.pathname,
    canonicalQuery(url),
    names.map((name) => `${name}:${headers[name] ?? ''}\n`).join(''),
    signedHeaders,
    await sha256Hex(input.body),
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(await hmac(await signingKey(input, day), stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const sendable = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
  return { headers: { ...sendable, authorization }, canonicalRequest, stringToSign, signature };
}
