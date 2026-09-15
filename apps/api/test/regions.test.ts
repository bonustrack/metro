import { afterEach, describe, expect, test } from 'bun:test';
import { describeRegions } from '../src/aws/ec2.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the regions this account has enabled', () => {
  test('DescribeRegions is asked from us-east-1 and a region not opted into is left out', async () => {
    const seen: { url: string; body: URLSearchParams }[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
      return Promise.resolve(
        new Response(
          '<DescribeRegionsResponse xmlns="x"><regionInfo>' +
            '<item><regionName>eu-west-1</regionName><optInStatus>opt-in-not-required</optInStatus></item>' +
            '<item><regionName>ap-east-1</regionName><optInStatus>not-opted-in</optInStatus></item>' +
            '<item><regionName>ap-southeast-1</regionName><optInStatus>opt-in-not-required</optInStatus></item>' +
            '</regionInfo></DescribeRegionsResponse>',
        ),
      );
    }) as typeof fetch;
    expect(await describeRegions({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's' })).toEqual([
      'ap-southeast-1',
      'eu-west-1',
    ]);
    expect(seen[0]?.url).toBe('https://ec2.us-east-1.amazonaws.com/');
    expect(seen[0]?.body.get('Action')).toBe('DescribeRegions');
  });
});
