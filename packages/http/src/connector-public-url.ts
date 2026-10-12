import { BlockList, isIP } from 'node:net';
import { parseConnectorUrl, refused } from './connector-url.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 32], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16],
] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicConnectorAddress(address: string, family: number): boolean {
  if (family === 4) return isIP(address) === 4 && !blocked.check(address, 'ipv4');
  return isIP(address) === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function publicHost(host: string): boolean {
  const family = isIP(host);
  if (family !== 0) return publicConnectorAddress(host, family);
  if (/(^|\.)(localhost|local|internal|lan|home|invalid|test|onion)$/.test(host)) return false;
  return host.includes('.') && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function invalidText(raw: string): boolean {
  return raw.length > 2048 || /[\s\\#]/.test(raw) || /%(?![0-9a-f]{2})/i.test(raw);
}

export function parsePublicConnectorUrl(raw: unknown): URL {
  const invalid = (): never => { throw refused('An organization endpoint must be a public HTTPS URL without user information or a fragment.'); };
  if (typeof raw !== 'string' || invalidText(raw)) return invalid();
  const authority = /^https:\/\/([^/ ?#]+)/i.exec(raw)?.[1];
  if (authority === undefined || authority.includes('@')) return invalid();
  let url: URL;
  try { url = parseConnectorUrl(raw); } catch { return invalid(); }
  if (url.toString().length > 2048 || !publicHost(url.hostname.replace(/^\[|\]$/g, ''))) return invalid();
  return url;
}

export function publicOAuthResource(raw: unknown): string {
  try {
    const url = parsePublicConnectorUrl(raw);
    if (typeof raw === 'string' && !raw.includes('?') && url.search === '') return raw;
  } catch {
    throw refused('The public OAuth resource must be a public HTTPS identifier without a query, user information or a fragment. Do not enter credentials.');
  }
  throw refused('The public OAuth resource must be a public HTTPS identifier without a query, user information or a fragment. Do not enter credentials.');
}

export function optionalOAuthResource(raw: unknown): string | undefined {
  return raw === undefined || raw === '' ? undefined : publicOAuthResource(raw);
}

export function boundOAuthResource(target: string, raw: unknown): string {
  const resource = publicOAuthResource(raw);
  const transport = parsePublicConnectorUrl(target);
  const url = new URL(resource);
  const path = url.pathname.replace(/\/$/, '');
  if (url.origin !== transport.origin || !(path === '' || transport.pathname === path || transport.pathname.startsWith(`${path}/`))) throw refused('The public OAuth resource does not identify this endpoint. Check the provider’s documented resource.');
  return resource;
}
