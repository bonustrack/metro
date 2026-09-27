import { beforeEach, describe, expect, test } from 'bun:test';
import { AwsError, type InstanceTypeInfo } from '../src/aws/ec2.ts';
import { catalogFor, offeredFor, resetSizes, type SizeDeps } from '../src/aws/sizes.ts';

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const SPECS: Record<string, [number, number, string]> = {
  't4g.small': [2, 2048, 'arm64'],
  't4g.medium': [2, 4096, 'arm64'],
  't4g.large': [2, 8192, 'arm64'],
  't4g.xlarge': [4, 16384, 'arm64'],
  't4g.2xlarge': [8, 32768, 'arm64'],
  'm7g.large': [2, 8192, 'arm64'],
  'm7g.xlarge': [4, 16384, 'arm64'],
  't3.medium': [2, 4096, 'x86_64'],
  't3.large': [2, 8192, 'x86_64'],
};

let asked: string[][] = [];
let priced: string[] = [];
let now = 0;
let priceFails = false;

const deps: SizeDeps = {
  types: (_c, _r, names) => {
    asked.push(names);
    const infos: InstanceTypeInfo[] = names.flatMap((type) => {
      const spec = SPECS[type];
      return spec === undefined ? [] : [{ type, vcpus: spec[0], memoryMib: spec[1], architectures: [spec[2]] }];
    });
    return Promise.resolve(infos);
  },
  price: (_c, _r, type) => {
    priced.push(type);
    if (priceFails) return Promise.reject(new AwsError('AccessDeniedException', 'denied', 'pricing:GetProducts'));
    return Promise.resolve((SPECS[type]?.[1] ?? 0) / 100_000);
  },
  now: () => now,
};

beforeEach(() => {
  resetSizes();
  asked = [];
  priced = [];
  now = 0;
  priceFails = false;
});

describe('the sizes offered for a box', () => {
  test('are the same CPU kind as the box, offered in its region, the current one apart, smallest first', async () => {
    const catalog = await catalogFor(deps, CREDS, 'eu-central-2', 'arm64', 't4g.medium');
    expect(asked[0]).toEqual(offeredFor('arm64'));
    expect(catalog.current).toEqual({ type: 't4g.medium', vcpus: 2, memoryMib: 4096, hourlyUsd: 0.04096 });
    expect(catalog.options.map((s) => s.type)).toEqual(['t4g.large', 'm7g.large', 't4g.xlarge', 'm7g.xlarge', 't4g.2xlarge']);
  });

  test('an x86 box is offered x86 sizes only', async () => {
    const catalog = await catalogFor(deps, CREDS, 'us-east-1', 'x86_64', 't3.medium');
    expect(catalog.options.map((s) => s.type)).toEqual(['t3.large']);
  });

  test('a box on a size outside the list still shows it, but it is not offered back', async () => {
    const catalog = await catalogFor(deps, CREDS, 'us-east-1', 'arm64', 't4g.small');
    expect(asked[0]?.[0]).toBe('t4g.small');
    expect(catalog.current?.memoryMib).toBe(2048);
    expect(catalog.options.some((s) => s.type === 't4g.small')).toBe(false);
    expect(catalog.options[0]?.type).toBe('t4g.medium');
  });

  test('an unknown architecture offers nothing', async () => {
    expect(await catalogFor(deps, CREDS, 'us-east-1', 'i386', 'm1.small')).toEqual({ current: null, options: [] });
    expect(asked).toEqual([['m1.small']]);
    expect(await catalogFor(deps, CREDS, 'us-east-1', 'i386', '')).toEqual({ current: null, options: [] });
    expect(asked.length).toBe(1);
  });

  test('the list is kept for a day once priced', async () => {
    await catalogFor(deps, CREDS, 'us-east-1', 'arm64', 't4g.medium');
    now += 23 * 60 * 60_000;
    await catalogFor(deps, CREDS, 'us-east-1', 'arm64', 't4g.large');
    expect(asked.length).toBe(1);
    now += 2 * 60 * 60_000;
    await catalogFor(deps, CREDS, 'us-east-1', 'arm64', 't4g.medium');
    expect(asked.length).toBe(2);
  });

  test('a price list that refuses leaves the prices empty and is asked again ten minutes later', async () => {
    priceFails = true;
    const catalog = await catalogFor(deps, CREDS, 'us-east-1', 'arm64', 't4g.medium');
    expect(catalog.current?.hourlyUsd).toBeNull();
    expect(catalog.options.every((s) => s.hourlyUsd === null)).toBe(true);
    priceFails = false;
    now += 11 * 60_000;
    expect((await catalogFor(deps, CREDS, 'us-east-1', 'arm64', 't4g.medium')).current?.hourlyUsd).toBe(0.04096);
    expect(asked.length).toBe(2);
  });
});
