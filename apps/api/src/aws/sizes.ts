import { errMsg, log } from '@metro-labs/core/log';
import { AwsError, type AwsCredentials, type InstanceTypeInfo } from './ec2.js';

const OFFERED: Record<string, string[]> = {
  arm64: ['t4g.medium', 't4g.large', 't4g.xlarge', 't4g.2xlarge', 'm7g.large', 'm7g.xlarge', 'm7g.2xlarge'],
  x86_64: ['t3.medium', 't3.large', 't3.xlarge', 't3.2xlarge', 'm7i.large', 'm7i.xlarge', 'm7i.2xlarge'],
};
const PRICED_TTL_MS = 24 * 60 * 60_000;
const UNPRICED_TTL_MS = 10 * 60_000;

export interface Size {
  type: string;
  vcpus: number;
  memoryMib: number;
  hourlyUsd: number | null;
}

export interface SizeDeps {
  types: (credentials: AwsCredentials, region: string, names: string[]) => Promise<InstanceTypeInfo[]>;
  price: (credentials: AwsCredentials, region: string, type: string) => Promise<number | null>;
  now: () => number;
}

export interface Catalog {
  current: Size | null;
  options: Size[];
}

const cache = new Map<string, { at: number; ttl: number; sizes: Size[] }>();

export function resetSizes(): void {
  cache.clear();
}

export const offeredFor = (architecture: string): string[] => OFFERED[architecture] ?? [];

const bySize = (names: string[]) => (a: Size, b: Size): number =>
  a.memoryMib - b.memoryMib || a.vcpus - b.vcpus || names.indexOf(a.type) - names.indexOf(b.type);

async function pricesOf(deps: SizeDeps, credentials: AwsCredentials, region: string, types: string[]): Promise<(number | null)[]> {
  const failures: unknown[] = [];
  const prices = await Promise.all(
    types.map((type) =>
      deps.price(credentials, region, type).catch((err: unknown) => {
        failures.push(err);
        return null;
      }),
    ),
  );
  const first = failures[0];
  if (first !== undefined)
    log.warn(
      { region, missing: failures.length, code: first instanceof AwsError ? first.code : 'Error', err: errMsg(first) },
      'size: the AWS price list did not answer, so the page shows no price',
    );
  return prices;
}

async function build(deps: SizeDeps, credentials: AwsCredentials, region: string, architecture: string, names: string[]): Promise<Size[]> {
  const infos = (await deps.types(credentials, region, names)).filter((info) => info.architectures.includes(architecture));
  const prices = await pricesOf(deps, credentials, region, infos.map((info) => info.type));
  const sizes = infos.map((info, at) => ({ type: info.type, vcpus: info.vcpus, memoryMib: info.memoryMib, hourlyUsd: prices[at] ?? null }));
  return sizes.sort(bySize(names));
}

async function sizesOf(deps: SizeDeps, credentials: AwsCredentials, region: string, architecture: string, names: string[]): Promise<Size[]> {
  const key = `${region}/${architecture}/${names.join(',')}`;
  const now = deps.now();
  const held = cache.get(key);
  if (held !== undefined && now - held.at < held.ttl) return held.sizes;
  const sizes = names.length === 0 ? [] : await build(deps, credentials, region, architecture, names);
  cache.set(key, { at: now, ttl: sizes.every((size) => size.hourlyUsd !== null) ? PRICED_TTL_MS : UNPRICED_TTL_MS, sizes });
  return sizes;
}

export async function catalogFor(
  deps: SizeDeps,
  credentials: AwsCredentials,
  region: string,
  architecture: string,
  current: string,
): Promise<Catalog> {
  const offered = offeredFor(architecture);
  const names = offered.includes(current) || current === '' ? offered : [current, ...offered];
  const sizes = await sizesOf(deps, credentials, region, architecture, names);
  return {
    current: sizes.find((size) => size.type === current) ?? null,
    options: sizes.filter((size) => size.type !== current && offered.includes(size.type)),
  };
}
