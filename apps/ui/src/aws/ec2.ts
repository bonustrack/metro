import { signV4 } from './sigv4.js';
import { child, children, parseXml, textAt, type XmlNode } from './xml.js';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export class AwsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AwsError';
  }
}

export const EC2_VERSION = '2016-11-15';
export const INSTANCE_TYPE = 't4g.medium';
export const ROOT_GIB = '8';
const CANONICAL = '099720109477';
const UBUNTU_NAME = 'ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-arm64-server-*';
const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

export const ec2Endpoint = (region: string): string => `https://ec2.${region}.amazonaws.com/`;

export async function ec2(
  credentials: AwsCredentials,
  region: string,
  action: string,
  params: Record<string, string>,
): Promise<XmlNode> {
  const url = ec2Endpoint(region);
  const body = new URLSearchParams({ Action: action, Version: EC2_VERSION, ...params }).toString();
  const signed = await signV4({
    method: 'POST',
    url,
    headers: { 'content-type': CONTENT_TYPE },
    body,
    region,
    service: 'ec2',
    ...credentials,
  });
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: signed.headers, body });
  } catch {
    throw new AwsError('Unreachable', `Could not reach EC2 in ${region}.`);
  }
  const xml = parseXml(await res.text());
  if (res.ok) return xml;
  const error = child(child(xml, 'Errors'), 'Error');
  throw new AwsError(textAt(error, 'Code') || `HTTP${res.status}`, textAt(error, 'Message') || `EC2 answered ${res.status}.`);
}

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
  userData: string;
  clientToken: string;
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
    'TagSpecification.1.ResourceType': 'instance',
    'TagSpecification.1.Tag.1.Key': 'Name',
    'TagSpecification.1.Tag.1.Value': spec.name,
    'TagSpecification.1.Tag.2.Key': 'metro',
    'TagSpecification.1.Tag.2.Value': spec.node,
  };
}

export async function runInstance(credentials: AwsCredentials, region: string, spec: InstanceSpec): Promise<string> {
  const xml = await ec2(credentials, region, 'RunInstances', runInstanceParams(spec));
  const instanceId = textAt(child(child(xml, 'instancesSet'), 'item'), 'instanceId');
  if (instanceId === '') throw new AwsError('NoInstance', 'EC2 answered without an instance id.');
  return instanceId;
}

export interface InstanceState {
  instanceId: string;
  state: string;
  publicIp: string | null;
}

export async function describeInstance(credentials: AwsCredentials, region: string, instanceId: string): Promise<InstanceState> {
  const xml = await ec2(credentials, region, 'DescribeInstances', { 'InstanceId.1': instanceId });
  const instance = child(child(child(child(xml, 'reservationSet'), 'item'), 'instancesSet'), 'item');
  if (instance === undefined) throw new AwsError('NotFound', `EC2 no longer lists ${instanceId}.`);
  const publicIp = textAt(instance, 'ipAddress');
  return { instanceId, state: textAt(instance, 'instanceState', 'name') || 'unknown', publicIp: publicIp === '' ? null : publicIp };
}
