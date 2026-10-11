import { BlockList, isIP } from 'node:net';
import { parseConnectorUrl } from '@metro-labs/http/connector-url';

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

function publicHost(host: string): boolean {
  if (isIP(host) === 4) return !blocked.check(host, 'ipv4');
  if (isIP(host) === 6) return globalV6.check(host, 'ipv6') && !blocked.check(host, 'ipv6');
  const name = host.replace(/\.$/, '');
  if (/(^|\.)(localhost|local|internal|lan|home|invalid|test|onion)$/.test(name)) return false;
  return name.includes('.') && name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function migrationOrigin(raw: unknown): string | null {
  try {
    const url = parseConnectorUrl(raw);
    if (url.protocol !== 'https:' || !publicHost(url.hostname.replace(/^\[|\]$/g, ''))) return null;
    return url.origin;
  } catch {
    return null;
  }
}
