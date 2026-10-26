import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { parsePublicConnectorUrl, publicConnectorAddress } from '@metro-labs/http/connector-public-url';
import type { FetchLike } from '@metro-labs/core/stations/oauth';

const NO_BODY = new Set([101, 103, 204, 205, 304]);

export interface EgressLimits {
  bodyMax: number;
  idleMs: number;
}

const DEFAULT_LIMITS: EgressLimits = { bodyMax: 64 * 1024 * 1024, idleMs: 20_000 };

class EgressRefused extends Error {}

export type Resolve = (hostname: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err === null) resolve(addresses);
      else reject(err);
    });
  });

type LookupDone = (err: Error | null, address: string | LookupAddress[], family?: number) => void;

const familyOf = (family: number | string | undefined): number => {
  if (family === 4 || family === 'IPv4') return 4;
  return family === 6 || family === 'IPv6' ? 6 : 0;
};

function guardedLookup(resolve: Resolve): (hostname: string, options: { all?: boolean; family?: number | string }, done: LookupDone) => void {
  return (hostname, options, done) => {
    const family = familyOf(options.family);
    resolve(hostname)
      .then((found) => {
        const wanted = family === 0 ? found : found.filter((a) => a.family === family);
        const first = wanted[0];
        if (first === undefined) throw new EgressRefused(`${hostname} has no address`);
        if (!wanted.every((a) => publicConnectorAddress(a.address, a.family))) throw new EgressRefused(`${hostname} is a private address, which an organization connector may not use`);
        if (options.all === true) done(null, wanted);
        else done(null, first.address, first.family);
      })
      .catch((err: unknown) => {
        done(err instanceof Error ? err : new EgressRefused(`${hostname} did not resolve`), '', 4);
      });
  };
}

function targetOf(input: string): URL {
  try { return parsePublicConnectorUrl(input); } catch { throw new EgressRefused('Organization connectors require a public HTTPS address without user information or a fragment.'); }
}

function headersOf(init: RequestInit, body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    out[name] = value;
  });
  if (body !== undefined) out['content-length'] = String(Buffer.byteLength(body));
  return out;
}

function bodyOf(init: RequestInit, limits: EgressLimits): string | undefined {
  if (init.body === undefined || init.body === null) return undefined;
  if (typeof init.body !== 'string') throw new EgressRefused('an egress request body must be text');
  if (Buffer.byteLength(init.body) > limits.bodyMax) throw new EgressRefused('the request was larger than Metro sends');
  return init.body;
}

function answerOf(res: IncomingMessage, chunks: Buffer[]): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const status = res.statusCode ?? 502;
  return new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers });
}

function collect(res: IncomingMessage, limits: EgressLimits, settle: (err: Error | null, answer?: Response) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limits.bodyMax) res.destroy(new EgressRefused('the answer was larger than Metro reads'));
    else chunks.push(chunk);
  });
  res.on('error', (err) => {
    settle(err);
  });
  res.on('end', () => {
    settle(null, answerOf(res, chunks));
  });
}

function send(url: URL, init: RequestInit, resolve: Resolve, limits: EgressLimits): Promise<Response> {
  const body = bodyOf(init, limits);
  const options: RequestOptions = {
    protocol: 'https:',
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port === '' ? 443 : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: init.method ?? 'GET',
    headers: headersOf(init, body),
    lookup: guardedLookup(resolve),
  };
  return new Promise((done, fail) => {
    let settled = false;
    const req = request(options, (res) => {
      collect(res, limits, settle);
    });
    const abort = (): void => {
      req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new EgressRefused('the request was stopped'));
    };
    function settle(err: Error | null, answer?: Response): void {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener('abort', abort);
      if (err === null && answer !== undefined) done(answer);
      else fail(err ?? new EgressRefused('no answer'));
    }
    if (init.signal?.aborted === true) abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    req.setTimeout(limits.idleMs, () => {
      req.destroy(new EgressRefused('the server did not answer in time'));
    });
    req.on('error', (err) => {
      settle(err);
    });
    req.end(body);
  });
}

export function egressFetch(resolve: Resolve = systemResolve, limits: EgressLimits = DEFAULT_LIMITS): FetchLike {
  return (input, init = {}) => Promise.resolve(input).then((target) => send(targetOf(target), init, resolve, limits));
}
