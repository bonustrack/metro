import type { ModelOption } from '../api/model.js';
import { ec2, type AwsCredentials } from './ec2.js';
import { child, children, textAt } from './xml.js';

export const REGION_NAMES: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'ca-central-1': 'Canada (Central)',
  'ca-west-1': 'Canada West (Calgary)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-central-2': 'Europe (Zurich)',
  'eu-north-1': 'Europe (Stockholm)',
  'eu-south-1': 'Europe (Milan)',
  'eu-south-2': 'Europe (Spain)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-south-2': 'Asia Pacific (Hyderabad)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ap-southeast-5': 'Asia Pacific (Malaysia)',
  'ap-southeast-7': 'Asia Pacific (Thailand)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-east-1': 'Asia Pacific (Hong Kong)',
  'ap-east-2': 'Asia Pacific (Taipei)',
  'sa-east-1': 'South America (São Paulo)',
  'me-south-1': 'Middle East (Bahrain)',
  'me-central-1': 'Middle East (UAE)',
  'il-central-1': 'Israel (Tel Aviv)',
  'af-south-1': 'Africa (Cape Town)',
  'mx-central-1': 'Mexico (Central)',
};

export const STANDARD_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'sa-east-1',
];

export function regionLabel(code: string): string {
  const name = REGION_NAMES[code];
  return name === undefined ? code : `${name} · ${code}`;
}

export function regionRows(enabled: string[] | null): ModelOption[] {
  return [...(enabled ?? STANDARD_REGIONS)]
    .map((id) => ({ id, name: REGION_NAMES[id] ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function describeRegions(credentials: AwsCredentials): Promise<string[]> {
  const xml = await ec2(credentials, 'us-east-1', 'DescribeRegions', {});
  return children(child(xml, 'regionInfo'), 'item')
    .map((item) => ({ name: textAt(item, 'regionName'), status: textAt(item, 'optInStatus') }))
    .filter((r) => r.name !== '' && r.status !== 'not-opted-in')
    .map((r) => r.name)
    .sort();
}
