import { afterEach, describe, expect, test } from 'bun:test';
import { describeRegions, regionLabel, regionOptions, STANDARD_REGIONS } from '../src/aws/regions.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the region list', () => {
  test('DescribeRegions is asked from us-east-1 and answers the regions enabled in the account', async () => {
    const seen: { url: string; body: URLSearchParams }[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
      return Promise.resolve(
        new Response(
          '<DescribeRegionsResponse xmlns="x"><regionInfo>' +
            '<item><regionName>eu-west-1</regionName><regionEndpoint>ec2.eu-west-1.amazonaws.com</regionEndpoint><optInStatus>opt-in-not-required</optInStatus></item>' +
            '<item><regionName>ap-east-1</regionName><regionEndpoint>ec2.ap-east-1.amazonaws.com</regionEndpoint><optInStatus>not-opted-in</optInStatus></item>' +
            '<item><regionName>ap-southeast-1</regionName><regionEndpoint>ec2.ap-southeast-1.amazonaws.com</regionEndpoint><optInStatus>opt-in-not-required</optInStatus></item>' +
            '</regionInfo></DescribeRegionsResponse>',
        ),
      );
    }) as typeof fetch;
    expect(await describeRegions({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's' })).toEqual(['ap-southeast-1', 'eu-west-1']);
    expect(seen[0]?.url).toBe('https://ec2.us-east-1.amazonaws.com/');
    expect(seen[0]?.body.get('Action')).toBe('DescribeRegions');
  });

  test('options carry the human name beside the code, sorted by name, and an unknown code stands on its own', () => {
    const options = regionOptions(['eu-west-1', 'zz-new-9', 'us-east-1']);
    expect(options).toEqual([
      { value: 'eu-west-1', label: 'Europe (Ireland) · eu-west-1' },
      { value: 'us-east-1', label: 'US East (N. Virginia) · us-east-1' },
      { value: 'zz-new-9', label: 'zz-new-9' },
    ]);
    expect(regionLabel('ap-northeast-1')).toBe('Asia Pacific (Tokyo) · ap-northeast-1');
  });

  test('before a key is typed the standard regions stand in, every one of them named', () => {
    const options = regionOptions(null);
    expect(options).toHaveLength(STANDARD_REGIONS.length);
    for (const option of options) expect(option.label).not.toBe(option.value);
    expect(options.map((o) => o.value)).toContain('eu-west-1');
  });
});
