import { afterEach, describe, expect, test } from 'bun:test';
import { AwsError } from '../src/aws/ec2.ts';
import { cheapestGbMonth, cheapestHourly, gbMonthPrice, hourlyPrice, productQuery, storageQuery } from '../src/aws/pricing.ts';

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const product = (usd: string, unit = 'Hrs'): string =>
  JSON.stringify({
    product: { attributes: { instanceType: 't4g.large' } },
    terms: { OnDemand: { 'SKU.JRTCKXETXF': { priceDimensions: { 'SKU.JRTCKXETXF.6YS6EN2CT7': { unit, pricePerUnit: { USD: usd } } } } } },
  });

describe('the AWS price list', () => {
  test('asks for shared Linux on-demand of one type in one region', () => {
    const query = JSON.parse(productQuery('eu-central-2', 't4g.large')) as { ServiceCode: string; Filters: { Field: string; Value: string }[] };
    expect(query.ServiceCode).toBe('AmazonEC2');
    expect(Object.fromEntries(query.Filters.map((f) => [f.Field, f.Value]))).toEqual({
      regionCode: 'eu-central-2',
      instanceType: 't4g.large',
      operatingSystem: 'Linux',
      tenancy: 'Shared',
      preInstalledSw: 'NA',
      capacitystatus: 'Used',
    });
  });

  test('reads the hourly dollar price out of the product documents', () => {
    expect(cheapestHourly({ PriceList: [product('0.0672000000'), product('0.0800000000')] })).toBe(0.0672);
    expect(cheapestHourly({ PriceList: [product('0.0000000000'), product('3', 'Quantity'), '{not json'] })).toBeNull();
    expect(cheapestHourly({})).toBeNull();
  });

  test('asks for the storage price of one volume type in one region, per GB-month', async () => {
    const query = JSON.parse(storageQuery('eu-central-2', 'gp3')) as { ServiceCode: string; Filters: { Field: string; Value: string }[] };
    expect(query.ServiceCode).toBe('AmazonEC2');
    expect(Object.fromEntries(query.Filters.map((f) => [f.Field, f.Value]))).toEqual({ regionCode: 'eu-central-2', productFamily: 'Storage', volumeApiName: 'gp3' });
    expect(cheapestGbMonth({ PriceList: [product('0.1142000000', 'GB-Mo'), product('0.0336')] })).toBe(0.1142);
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ PriceList: [product('0.08', 'GB-Mo')] }), { status: 200 }))) as typeof fetch;
    expect(await gbMonthPrice(CREDS, 'us-east-1', 'gp3')).toBe(0.08);
  });

  test('signs a JSON call for the pricing service in us-east-1', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) };
      return Promise.resolve(new Response(JSON.stringify({ FormatVersion: 'aws_v1', PriceList: [product('0.0336')] }), { status: 200 }));
    }) as typeof fetch;
    expect(await hourlyPrice(CREDS, 'us-east-1', 't4g.medium')).toBe(0.0336);
    const call = seen as unknown as { url: string; headers: Record<string, string>; body: string };
    expect(call.url).toBe('https://api.pricing.us-east-1.amazonaws.com/');
    expect(call.headers['x-amz-target']).toBe('AWSPriceListService.GetProducts');
    expect(call.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(call.headers.authorization).toMatch(/Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/pricing\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target,/);
    expect(call.body).toContain('t4g.medium');
  });

  test('a refusal is an AwsError naming the permission', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ __type: 'com.amazon.coral.service#AccessDeniedException', Message: 'User is not authorized' }), { status: 400 }))) as typeof fetch;
    const err = await hourlyPrice(CREDS, 'us-east-1', 't4g.medium').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsError);
    expect(err).toMatchObject({ code: 'AccessDeniedException', action: 'pricing:GetProducts', message: 'User is not authorized' });
  });
});
