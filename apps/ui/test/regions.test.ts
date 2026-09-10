import { afterEach, describe, expect, test } from 'bun:test';
import { describeRegions, regionLabel, regionRows, STANDARD_REGIONS } from '../src/aws/regions.ts';
import { matchModels } from '../src/api/model.ts';

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

  test('rows carry the human name beside the code, sorted by name, and an unknown code stands on its own', () => {
    const rows = regionRows(['eu-west-1', 'zz-new-9', 'us-east-1']);
    expect(rows).toEqual([
      { id: 'eu-west-1', name: 'Europe (Ireland)' },
      { id: 'us-east-1', name: 'US East (N. Virginia)' },
      { id: 'zz-new-9', name: 'zz-new-9' },
    ]);
    expect(regionLabel('ap-northeast-1')).toBe('Asia Pacific (Tokyo) · ap-northeast-1');
  });

  test('the picker finds a region by any word of its name or its code', () => {
    const rows = regionRows(null);
    expect(matchModels(rows, 'ireland').map((r) => r.id)).toEqual(['eu-west-1']);
    expect(matchModels(rows, 'eu-west').map((r) => r.id)).toEqual(['eu-west-1', 'eu-west-2', 'eu-west-3']);
    expect(matchModels(rows, 'asia tokyo').map((r) => r.id)).toEqual(['ap-northeast-1']);
  });

  test('before a key is typed the standard regions stand in, every one of them named', () => {
    const rows = regionRows(null);
    expect(rows).toHaveLength(STANDARD_REGIONS.length);
    for (const row of rows) expect(row.name).not.toBe(row.id);
    expect(rows.map((r) => r.id)).toContain('eu-west-1');
  });
});
