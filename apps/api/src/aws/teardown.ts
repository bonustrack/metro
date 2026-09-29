import { AwsError, ec2, type AwsCredentials } from './ec2.js';
import { child, children, textAt, type XmlNode } from './xml.js';

export const INSTANCE_ID_RE = /^i-[0-9a-f]{8,17}$/;
export const VOLUME_ID_RE = /^vol-[0-9a-f]{8,17}$/;

export type Tags = Record<string, string>;

export interface Disk {
  device: string;
  volumeId: string;
  deleteOnTermination: boolean;
}

export interface InstanceFacts {
  instanceId: string;
  state: string;
  type: string;
  tags: Tags;
  disks: Disk[];
  profile: string | null;
}

export interface VolumeFacts {
  volumeId: string;
  sizeGib: number;
  state: string;
  tags: Tags;
  attachedTo: string[];
  multiAttach: boolean;
}

function checked(id: string, re: RegExp, what: string): string {
  if (!re.test(id)) throw new AwsError('Malformed', `${what} ${id === '' ? '(empty)' : id} is not an id AWS uses.`);
  return id;
}

const tagsOf = (node: XmlNode | undefined): Tags =>
  Object.fromEntries(children(child(node, 'tagSet'), 'item').map((item) => [textAt(item, 'key'), textAt(item, 'value')]));

const diskOf = (item: XmlNode): Disk => ({
  device: textAt(item, 'deviceName'),
  volumeId: textAt(item, 'ebs', 'volumeId'),
  deleteOnTermination: textAt(item, 'ebs', 'deleteOnTermination') === 'true',
});

const instanceOf = (item: XmlNode): InstanceFacts => ({
  instanceId: textAt(item, 'instanceId'),
  state: textAt(item, 'instanceState', 'name') || 'unknown',
  type: textAt(item, 'instanceType'),
  tags: tagsOf(item),
  disks: children(child(item, 'blockDeviceMapping'), 'item')
    .filter((item) => child(item, 'ebs') !== undefined)
    .map(diskOf),
  profile: textAt(item, 'iamInstanceProfile', 'arn') || null,
});

export async function describeInstanceFacts(credentials: AwsCredentials, region: string, instanceId: string): Promise<InstanceFacts[]> {
  const xml = await ec2(credentials, region, 'DescribeInstances', { 'InstanceId.1': checked(instanceId, INSTANCE_ID_RE, 'The server') });
  return children(child(xml, 'reservationSet'), 'item').flatMap((reservation) => children(child(reservation, 'instancesSet'), 'item').map(instanceOf));
}

const volumeOf = (item: XmlNode): VolumeFacts => ({
  volumeId: textAt(item, 'volumeId'),
  sizeGib: Number(textAt(item, 'size')) || 0,
  state: textAt(item, 'status'),
  tags: tagsOf(item),
  attachedTo: children(child(item, 'attachmentSet'), 'item').map((a) => textAt(a, 'instanceId')),
  multiAttach: textAt(item, 'multiAttachEnabled') === 'true',
});

export async function describeVolumeFacts(credentials: AwsCredentials, region: string, volumeIds: string[]): Promise<VolumeFacts[]> {
  if (volumeIds.length === 0) return [];
  const params = Object.fromEntries(volumeIds.map((id, at) => [`VolumeId.${String(at + 1)}`, checked(id, VOLUME_ID_RE, 'The disk')]));
  const xml = await ec2(credentials, region, 'DescribeVolumes', params);
  return children(child(xml, 'volumeSet'), 'item').map(volumeOf);
}

export async function deleteDiskWithServer(credentials: AwsCredentials, region: string, instanceId: string, device: string): Promise<void> {
  await ec2(credentials, region, 'ModifyInstanceAttribute', {
    InstanceId: checked(instanceId, INSTANCE_ID_RE, 'The server'),
    'BlockDeviceMapping.1.DeviceName': device,
    'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
  });
}

export async function terminateInstance(credentials: AwsCredentials, region: string, instanceId: string): Promise<string[]> {
  const xml = await ec2(credentials, region, 'TerminateInstances', { 'InstanceId.1': checked(instanceId, INSTANCE_ID_RE, 'The server') });
  return children(child(xml, 'instancesSet'), 'item').map((item) => textAt(item, 'instanceId'));
}
