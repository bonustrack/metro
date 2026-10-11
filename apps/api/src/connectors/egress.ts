import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { FetchLike } from '@metro-labs/core/stations/oauth';

const BODY_MAX = 1024 * 1024;
const IDLE_MS = 20_000;
const NO_BODY = new Set([101, 103, 204, 205, 304]);

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const SPECIAL_V6: [string, number][] = [['2001::', 32], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16]];

const privateV4 = new BlockList();
for (const [net, prefix] of PRIVATE_V4) privateV4.addSubnet(net, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [net, prefix] of SPECIAL_V6) specialV6.addSubnet(net, prefix, 'ipv6');

export class EgressRefused extends Error {}

export function publicAddress(address: string, family: number): boolean {
  if (family === 4) return isIP(address) === 4 && !privateV4.check(address, 'ipv4');
  return isIP(address) === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}

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
        if (!wanted.every((a) => publicAddress(a.address, a.family))) throw new EgressRefused(`${hostname} is a private address, which an organization connector may not use`);
        if (options.all === true) done(null, wanted);
        else done(null, first.address, first.family);
      })
      .catch((err: unknown) => {
        done(err instanceof Error ? err : new EgressRefused(`${hostname} did not resolve`), '', 4);
      });
  };
}

function targetOf(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:') throw new EgressRefused('Metro reaches organization connectors over https only');
  if (url.username !== '' || url.password !== '') throw new EgressRefused('a connector address must not carry a user:password');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family !== 0 && !publicAddress(host, family)) throw new EgressRefused(`${host} is a private address, which an organization connector may not use`);
  return url;
}

function headersOf(init: RequestInit, body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    out[name] = value;
  });
  if (body !== undefined) out['content-length'] = String(Buffer.byteLength(body));
  return out;
}

function bodyOf(init: RequestInit): string | undefined {
  if (init.body === undefined || init.body === null) return undefined;
  if (typeof init.body !== 'string') throw new EgressRefused('an egress request body must be text');
  if (Buffer.byteLength(init.body) > BODY_MAX) throw new EgressRefused('the request was larger than Metro sends');
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

function collect(res: IncomingMessage, settle: (err: Error | null, answer?: Response) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_MAX) res.destroy(new EgressRefused('the answer was larger than Metro reads'));
    else chunks.push(chunk);
  });
  res.on('error', (err) => {
    settle(err);
  });
  res.on('end', () => {
    settle(null, answerOf(res, chunks));
  });
}

function send(url: URL, init: RequestInit, resolve: Resolve): Promise<Response> {
  const body = bodyOf(init);
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
      collect(res, settle);
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
    req.setTimeout(IDLE_MS, () => {
      req.destroy(new EgressRefused('the server did not answer in time'));
    });
    req.on('error', (err) => {
      settle(err);
    });
    req.end(body);
  });
}

export function egressFetch(resolve: Resolve = systemResolve): FetchLike {
  return (input, init = {}) => Promise.resolve(input).then((target) => send(targetOf(target), init, resolve));
}
