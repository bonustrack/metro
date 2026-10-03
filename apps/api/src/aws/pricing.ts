import { isRecord } from '@metro-labs/core/is-record';
import { AwsError, keysOf, type AwsCredentials } from './ec2.js';
import { signV4 } from '@metro-labs/http/sigv4';

const PRICING_REGION = 'us-east-1';
const PRICING_URL = `https://api.pricing.${PRICING_REGION}.amazonaws.com/`;
const TARGET = 'AWSPriceListService.GetProducts';
const JSON_TYPE = 'application/x-amz-json-1.1';
const ACTION = 'pricing:GetProducts';

const term = (field: string, value: string): { Type: string; Field: string; Value: string } => ({ Type: 'TERM_MATCH', Field: field, Value: value });

type Filter = ReturnType<typeof term>;

const query = (filters: Filter[]): string => JSON.stringify({ ServiceCode: 'AmazonEC2', FormatVersion: 'aws_v1', MaxResults: 10, Filters: filters });

export const productQuery = (region: string, type: string): string =>
  query([
    term('regionCode', region),
    term('instanceType', type),
    term('operatingSystem', 'Linux'),
    term('tenancy', 'Shared'),
    term('preInstalledSw', 'NA'),
    term('capacitystatus', 'Used'),
  ]);

export const storageQuery = (region: string, volumeType: string): string =>
  query([term('regionCode', region), term('productFamily', 'Storage'), term('volumeApiName', volumeType)]);

const valuesOf = (value: unknown): unknown[] => (isRecord(value) ? Object.values(value) : []);

function parsed(item: unknown): unknown {
  if (typeof item !== 'string') return item;
  try {
    return JSON.parse(item);
  } catch {
    return null;
  }
}

function rates(item: unknown, unit: string): number[] {
  const product = parsed(item);
  const terms = isRecord(product) && isRecord(product.terms) ? product.terms.OnDemand : undefined;
  return valuesOf(terms)
    .flatMap((offer) => valuesOf(isRecord(offer) ? offer.priceDimensions : undefined))
    .flatMap((dimension) => {
      if (!isRecord(dimension) || dimension.unit !== unit || !isRecord(dimension.pricePerUnit)) return [];
      const usd = Number(dimension.pricePerUnit.USD);
      return Number.isFinite(usd) && usd > 0 ? [usd] : [];
    });
}

function cheapest(body: unknown, unit: string): number | null {
  const list = isRecord(body) && Array.isArray(body.PriceList) ? body.PriceList : [];
  const found = list.flatMap((item) => rates(item, unit));
  return found.length === 0 ? null : Math.min(...found);
}

export const cheapestHourly = (body: unknown): number | null => cheapest(body, 'Hrs');

export const cheapestGbMonth = (body: unknown): number | null => cheapest(body, 'GB-Mo');

function refusal(body: unknown, status: number): AwsError {
  const kind = isRecord(body) && typeof body.__type === 'string' ? body.__type : `HTTP${String(status)}`;
  const message = isRecord(body) && typeof body.Message === 'string' ? body.Message : isRecord(body) && typeof body.message === 'string' ? body.message : `The AWS Price List answered ${String(status)}.`;
  return new AwsError(kind.split('#').pop() ?? kind, message, ACTION);
}

async function products(credentials: AwsCredentials, body: string): Promise<unknown> {
  const signed = await signV4({
    method: 'POST',
    url: PRICING_URL,
    headers: { 'content-type': JSON_TYPE, 'x-amz-target': TARGET },
    body,
    region: PRICING_REGION,
    service: 'pricing',
    ...(await keysOf(credentials)),
  });
  let res: Response;
  try {
    res = await fetch(PRICING_URL, { method: 'POST', headers: signed.headers, body });
  } catch {
    throw new AwsError('Unreachable', 'Could not reach the AWS Price List.', ACTION);
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) throw refusal(answer, res.status);
  return answer;
}

export const hourlyPrice = async (credentials: AwsCredentials, region: string, type: string): Promise<number | null> =>
  cheapestHourly(await products(credentials, productQuery(region, type)));

export const gbMonthPrice = async (credentials: AwsCredentials, region: string, volumeType: string): Promise<number | null> =>
  cheapestGbMonth(await products(credentials, storageQuery(region, volumeType)));
