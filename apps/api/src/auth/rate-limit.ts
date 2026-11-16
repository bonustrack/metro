import type { IncomingMessage } from 'node:http';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

const TRACKED_MAX = 5000;

const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_V4) {
  const [net, bits] = range.split('/');
  cloudflare.addSubnet(net ?? '', Number(bits), 'ipv4');
}
for (const range of CLOUDFLARE_V6) {
  const [net, bits] = range.split('/');
  cloudflare.addSubnet(net ?? '', Number(bits), 'ipv6');
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const first = typeof value === 'string' ? value.split(',')[0]?.trim() : '';
  return first === undefined || first === '' ? null : first;
}

function plain(address: string): string {
  const bare = address.replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  return mapped?.[1] ?? bare;
}

export const fromCloudflare = (address: string): boolean => {
  const ip = plain(address);
  if (isIPv4(ip)) return cloudflare.check(ip, 'ipv4');
  return isIPv6(ip) && cloudflare.check(ip, 'ipv6');
};

function v6Network(ip: string): string {
  const [head = '', tail] = ip.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const width = [...left, ...right].reduce((sum, group) => sum + (group.includes('.') ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array.from({ length: 8 - width }, () => '0'), ...right];
  return `${groups.slice(0, 4).map((group) => group.padStart(4, '0')).join(':')}::/64`;
}

export function addressBucket(address: string): string {
  const ip = plain(address);
  return isIPv6(ip) ? v6Network(ip) : ip;
}

export function clientAddress(req: IncomingMessage): string {
  const fly = header(req, 'fly-client-ip');
  const viaCloudflare = fly !== null && fromCloudflare(fly) ? header(req, 'cf-connecting-ip') : null;
  return addressBucket(viaCloudflare ?? fly ?? req.socket.remoteAddress ?? 'unknown');
}

export class RateLimit {
  private readonly tries = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  spend(key: string, now: number): boolean {
    const recent = (this.tries.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) return false;
    this.tries.delete(key);
    this.tries.set(key, [...recent, now]);
    while (this.tries.size > TRACKED_MAX) {
      const first = this.tries.keys().next().value;
      if (first === undefined) break;
      this.tries.delete(first);
    }
    return true;
  }
}
