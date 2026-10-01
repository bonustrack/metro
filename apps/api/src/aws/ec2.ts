import { signV4 } from '@metro-labs/http/sigv4';
import { child, children, parseXml, textAt, type XmlNode } from './xml.js';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export class AwsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action = '',
  ) {
    super(message);
    this.name = 'AwsError';
  }
}

const EC2_VERSION = '2016-11-15';
export const INSTANCE_TYPE = 't4g.medium';
const ROOT_GIB = '8';
const CANONICAL = '099720109477';
const UBUNTU_NAME = 'ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-arm64-server-*';
const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

export interface QueryService {
  host: string;
  region: string;
  signingName: string;
  iamPrefix: string;
  version: string;
  label: string;
}

export async function awsQuery(credentials: AwsCredentials, service: QueryService, action: string, params: Record<string, string>): Promise<XmlNode> {
  const url = `https://${service.host}/`;
  const body = new URLSearchParams({ Action: action, Version: service.version, ...params }).toString();
  const signed = await signV4({
    method: 'POST',
    url,
    headers: { 'content-type': CONTENT_TYPE },
    body,
    region: service.region,
    service: service.signingName,
    ...credentials,
  });
  const iamAction = `${service.iamPrefix}:${action}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: signed.headers, body });
  } catch {
    throw new AwsError('Unreachable', `Could not reach ${service.label}.`, iamAction);
  }
  const xml = parseXml(await res.text());
  if (res.ok) return xml;
  const error = child(child(xml, 'Errors'), 'Error') ?? child(xml, 'Error');
  throw new AwsError(textAt(error, 'Code') || `HTTP${res.status}`, textAt(error, 'Message') || `${service.label} answered ${String(res.status)}.`, iamAction);
}

export const ec2 = (credentials: AwsCredentials, region: string, action: string, params: Record<string, string>): Promise<XmlNode> =>
  awsQuery(credentials, { host: `ec2.${region}.amazonaws.com`, region, signingName: 'ec2', iamPrefix: 'ec2', version: EC2_VERSION, label: `EC2 in ${region}` }, action, params);

export interface Image {
  imageId: string;
  name: string;
  creationDate: string;
}

const gp3First = (a: Image, b: Image): number => {
  const ga = a.name.includes('hvm-ssd-gp3') ? 1 : 0;
  const gb = b.name.includes('hvm-ssd-gp3') ? 1 : 0;
  return gb - ga || b.creationDate.localeCompare(a.creationDate);
};

export function pickImage(images: Image[]): Image | null {
  return [...images].filter((i) => i.imageId !== '').sort(gp3First)[0] ?? null;
}

export async function latestUbuntuArm64Image(credentials: AwsCredentials, region: string): Promise<Image> {
  const xml = await ec2(credentials, region, 'DescribeImages', {
    'Owner.1': CANONICAL,
    'Filter.1.Name': 'name',
    'Filter.1.Value.1': UBUNTU_NAME,
    'Filter.2.Name': 'architecture',
    'Filter.2.Value.1': 'arm64',
    'Filter.3.Name': 'state',
    'Filter.3.Value.1': 'available',
  });
  const images = children(child(xml, 'imagesSet'), 'item').map((item) => ({
    imageId: textAt(item, 'imageId'),
    name: textAt(item, 'name'),
    creationDate: textAt(item, 'creationDate'),
  }));
  const image = pickImage(images);
  if (image === null) throw new AwsError('NoImage', `No Ubuntu 24.04 arm64 image is published in ${region}.`);
  return image;
}

export interface InstanceSpec {
  imageId: string;
  name: string;
  node: string;
  agent: string;
  userData: string;
  clientToken: string;
  zone?: string;
  role?: string;
}

export const NODE_TAG = 'metro';
export const BOX_ROLE = 'metro-box';
export const AGENT_TAG = 'metro:agent';

function tagSpecification(at: number, type: string, spec: InstanceSpec): Record<string, string> {
  const tags: [string, string][] = [
    ['Name', spec.name],
    [NODE_TAG, spec.node],
    [AGENT_TAG, spec.agent],
  ];
  const prefix = `TagSpecification.${String(at)}`;
  const entries: [string, string][] = [
    [`${prefix}.ResourceType`, type],
    ...tags.flatMap(([key, value], i): [string, string][] => [
      [`${prefix}.Tag.${String(i + 1)}.Key`, key],
      [`${prefix}.Tag.${String(i + 1)}.Value`, value],
    ]),
  ];
  return Object.fromEntries(entries);
}

export const toBase64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

export function runInstanceParams(spec: InstanceSpec): Record<string, string> {
  return {
    ImageId: spec.imageId,
    InstanceType: INSTANCE_TYPE,
    MinCount: '1',
    MaxCount: '1',
    ClientToken: spec.clientToken,
    UserData: toBase64(spec.userData),
    'BlockDeviceMapping.1.DeviceName': '/dev/sda1',
    'BlockDeviceMapping.1.Ebs.VolumeSize': ROOT_GIB,
    'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3',
    'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
    'MetadataOptions.HttpTokens': 'required',
    'MetadataOptions.HttpEndpoint': 'enabled',
    'MetadataOptions.HttpPutResponseHopLimit': '1',
    ...tagSpecification(1, 'instance', spec),
    ...tagSpecification(2, 'volume', spec),
    ...(spec.zone === undefined ? {} : { 'Placement.AvailabilityZone': spec.zone }),
    ...(spec.role === undefined ? {} : { 'IamInstanceProfile.Name': spec.role }),
  };
}

export async function runInstance(credentials: AwsCredentials, region: string, spec: InstanceSpec): Promise<string> {
  const xml = await ec2(credentials, region, 'RunInstances', runInstanceParams(spec));
  const instanceId = textAt(child(child(xml, 'instancesSet'), 'item'), 'instanceId');
  if (instanceId === '') throw new AwsError('NoInstance', 'EC2 answered without an instance id.');
  return instanceId;
}

export async function describeZones(credentials: AwsCredentials, region: string): Promise<string[]> {
  const xml = await ec2(credentials, region, 'DescribeAvailabilityZones', {
    'Filter.1.Name': 'state',
    'Filter.1.Value.1': 'available',
    'Filter.2.Name': 'zone-type',
    'Filter.2.Value.1': 'availability-zone',
  });
  return children(child(xml, 'availabilityZoneInfo'), 'item')
    .map((item) => textAt(item, 'zoneName'))
    .filter((zone) => zone !== '')
    .sort();
}

export interface InstanceState {
  instanceId: string;
  state: string;
  publicIp: string | null;
  type: string;
  architecture: string;
}

export async function describeInstance(credentials: AwsCredentials, region: string, instanceId: string): Promise<InstanceState> {
  const xml = await ec2(credentials, region, 'DescribeInstances', { 'InstanceId.1': instanceId });
  const instance = child(child(child(child(xml, 'reservationSet'), 'item'), 'instancesSet'), 'item');
  if (instance === undefined) throw new AwsError('NotFound', `EC2 no longer lists ${instanceId}.`);
  const publicIp = textAt(instance, 'ipAddress');
  return {
    instanceId,
    state: textAt(instance, 'instanceState', 'name') || 'unknown',
    publicIp: publicIp === '' ? null : publicIp,
    type: textAt(instance, 'instanceType'),
    architecture: textAt(instance, 'architecture'),
  };
}

export async function associateProfile(credentials: AwsCredentials, region: string, instanceId: string, profile: string): Promise<void> {
  await ec2(credentials, region, 'AssociateIamInstanceProfile', { InstanceId: instanceId, 'IamInstanceProfile.Name': profile });
}

export async function stopInstance(credentials: AwsCredentials, region: string, instanceId: string): Promise<void> {
  await ec2(credentials, region, 'StopInstances', { 'InstanceId.1': instanceId });
}

export async function startInstance(credentials: AwsCredentials, region: string, instanceId: string): Promise<void> {
  await ec2(credentials, region, 'StartInstances', { 'InstanceId.1': instanceId });
}

export async function setInstanceType(credentials: AwsCredentials, region: string, instanceId: string, type: string): Promise<void> {
  await ec2(credentials, region, 'ModifyInstanceAttribute', { InstanceId: instanceId, 'InstanceType.Value': type });
}

export interface InstanceTypeInfo {
  type: string;
  vcpus: number;
  memoryMib: number;
  architectures: string[];
}

const count = (text: string): number => (/^\d+$/.test(text) ? Number(text) : 0);
const TYPE_PAGES_MAX = 50;

const typeInfo = (item: XmlNode): InstanceTypeInfo => ({
  type: textAt(item, 'instanceType'),
  vcpus: count(textAt(item, 'vCpuInfo', 'defaultVCpus')),
  memoryMib: count(textAt(item, 'memoryInfo', 'sizeInMiB')),
  architectures: children(child(child(item, 'processorInfo'), 'supportedArchitectures'), 'item').map((arch) => arch.text.trim()),
});

export async function describeInstanceTypes(credentials: AwsCredentials, region: string, types: string[]): Promise<InstanceTypeInfo[]> {
  const values = Object.fromEntries(types.map((type, at) => [`Filter.1.Value.${String(at + 1)}`, type]));
  const params = { MaxResults: '100', 'Filter.1.Name': 'instance-type', ...values };
  const infos: InstanceTypeInfo[] = [];
  let token = '';
  for (let page = 0; page < TYPE_PAGES_MAX; page += 1) {
    const xml = await ec2(credentials, region, 'DescribeInstanceTypes', token === '' ? params : { ...params, NextToken: token });
    infos.push(...children(child(xml, 'instanceTypeSet'), 'item').map(typeInfo));
    token = textAt(xml, 'nextToken');
    if (token === '') return infos.filter((info) => info.type !== '');
  }
  throw new AwsError('TooManyPages', `EC2 listed the instance types of ${region} in more than ${String(TYPE_PAGES_MAX)} pages.`, 'ec2:DescribeInstanceTypes');
}

export interface ConsoleOutput {
  text: string;
  at: string | null;
}

const fromBase64 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));

export async function consoleOutput(credentials: AwsCredentials, region: string, instanceId: string): Promise<ConsoleOutput> {
  const xml = await ec2(credentials, region, 'GetConsoleOutput', { InstanceId: instanceId, Latest: 'true' });
  const raw = textAt(xml, 'output');
  const at = textAt(xml, 'timestamp');
  return { text: raw === '' ? '' : fromBase64(raw), at: at === '' ? null : at };
}

export async function describeRegions(credentials: AwsCredentials): Promise<string[]> {
  const xml = await ec2(credentials, 'us-east-1', 'DescribeRegions', {});
  return children(child(xml, 'regionInfo'), 'item')
    .map((item) => ({ name: textAt(item, 'regionName'), status: textAt(item, 'optInStatus') }))
    .filter((r) => r.name !== '' && r.status !== 'not-opted-in')
    .map((r) => r.name)
    .sort();
}
