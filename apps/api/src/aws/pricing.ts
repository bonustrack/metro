import { isRecord } from '@metro-labs/core/is-record';
import { AwsError, type AwsCredentials } from './ec2.js';
import { signV4 } from './sigv4.js';

const PRICING_REGION = 'us-east-1';
const PRICING_URL = `https://api.pricing.${PRICING_REGION}.amazonaws.com/`;
const TARGET = 'AWSPriceListService.GetProducts';
const JSON_TYPE = 'application/x-amz-json-1.1';
const ACTION = 'pricing:GetProducts';

const term = (field: string, value: string): { Type: string; Field: string; Value: string } => ({ Type: 'TERM_MATCH', Field: field, Value: value });

export function productQuery(region: string, type: string): string {
  return JSON.stringify({
    ServiceCode: 'AmazonEC2',
    FormatVersion: 'aws_v1',
    MaxResults: 10,
    Filters: [
      term('regionCode', region),
      term('instanceType', type),
      term('operatingSystem', 'Linux'),
      term('tenancy', 'Shared'),
      term('preInstalledSw', 'NA'),
      term('capacitystatus', 'Used'),
    ],
  });
}

const valuesOf = (value: unknown): unknown[] => (isRecord(value) ? Object.values(value) : []);

function parsed(item: unknown): unknown {
  if (typeof item !== 'string') return item;
  try {
    return JSON.parse(item);
  } catch {
    return null;
  }
}

function hourlyRates(item: unknown): number[] {
  const product = parsed(item);
  const terms = isRecord(product) && isRecord(product.terms) ? product.terms.OnDemand : undefined;
  return valuesOf(terms)
    .flatMap((offer) => valuesOf(isRecord(offer) ? offer.priceDimensions : undefined))
    .flatMap((dimension) => {
      if (!isRecord(dimension) || dimension.unit !== 'Hrs' || !isRecord(dimension.pricePerUnit)) return [];
      const usd = Number(dimension.pricePerUnit.USD);
      return Number.isFinite(usd) && usd > 0 ? [usd] : [];
    });
}

export function cheapestHourly(body: unknown): number | null {
  const list = isRecord(body) && Array.isArray(body.PriceList) ? body.PriceList : [];
  const rates = list.flatMap(hourlyRates);
  return rates.length === 0 ? null : Math.min(...rates);
}

function refusal(body: unknown, status: number): AwsError {
  const kind = isRecord(body) && typeof body.__type === 'string' ? body.__type : `HTTP${String(status)}`;
  const message = isRecord(body) && typeof body.Message === 'string' ? body.Message : isRecord(body) && typeof body.message === 'string' ? body.message : `The AWS Price List answered ${String(status)}.`;
  return new AwsError(kind.split('#').pop() ?? kind, message, ACTION);
}

export async function hourlyPrice(credentials: AwsCredentials, region: string, type: string): Promise<number | null> {
  const body = productQuery(region, type);
  const signed = await signV4({
    method: 'POST',
    url: PRICING_URL,
    headers: { 'content-type': JSON_TYPE, 'x-amz-target': TARGET },
    body,
    region: PRICING_REGION,
    service: 'pricing',
    ...credentials,
  });
  let res: Response;
  try {
    res = await fetch(PRICING_URL, { method: 'POST', headers: signed.headers, body });
  } catch {
    throw new AwsError('Unreachable', 'Could not reach the AWS Price List.', ACTION);
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) throw refusal(answer, res.status);
  return cheapestHourly(answer);
}
