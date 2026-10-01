import { ec2, NODE_TAG, type AwsCredentials } from './ec2.js';
import { checked, INSTANCE_ID_RE, VOLUME_ID_RE } from './teardown.js';
import { child, children, textAt, type XmlNode } from './xml.js';

export type ModificationState = 'modifying' | 'optimizing' | 'completed' | 'failed';

export interface Modification {
  state: ModificationState;
  progress: number;
  originalGib: number;
  targetGib: number;
  startedAt: string;
  message: string;
}

const STATES: ModificationState[] = ['modifying', 'optimizing', 'completed', 'failed'];

const number = (text: string): number => (/^\d+$/.test(text) ? Number(text) : 0);

function modificationOf(item: XmlNode | undefined): Modification | null {
  const state = STATES.find((s) => s === textAt(item, 'modificationState'));
  if (item === undefined || state === undefined) return null;
  return {
    state,
    progress: number(textAt(item, 'progress')),
    originalGib: number(textAt(item, 'originalSize')),
    targetGib: number(textAt(item, 'targetSize')),
    startedAt: textAt(item, 'startTime'),
    message: textAt(item, 'statusMessage'),
  };
}

export async function lastModification(credentials: AwsCredentials, region: string, volumeId: string): Promise<Modification | null> {
  const xml = await ec2(credentials, region, 'DescribeVolumesModifications', {
    'Filter.1.Name': 'volume-id',
    'Filter.1.Value.1': checked(volumeId, VOLUME_ID_RE, 'The disk'),
  });
  const found = children(child(xml, 'volumeModificationSet'), 'item').filter((item) => textAt(item, 'volumeId') === volumeId);
  return modificationOf(found[0]);
}

export async function growVolume(credentials: AwsCredentials, region: string, volumeId: string, sizeGib: number): Promise<Modification | null> {
  const xml = await ec2(credentials, region, 'ModifyVolume', { VolumeId: checked(volumeId, VOLUME_ID_RE, 'The disk'), Size: String(sizeGib) });
  return modificationOf(child(xml, 'volumeModification'));
}

export async function tagVolumeNode(credentials: AwsCredentials, region: string, volumeId: string, node: string): Promise<void> {
  await ec2(credentials, region, 'CreateTags', {
    'ResourceId.1': checked(volumeId, VOLUME_ID_RE, 'The disk'),
    'Tag.1.Key': NODE_TAG,
    'Tag.1.Value': node,
  });
}

export async function rebootInstance(credentials: AwsCredentials, region: string, instanceId: string): Promise<void> {
  await ec2(credentials, region, 'RebootInstances', { 'InstanceId.1': checked(instanceId, INSTANCE_ID_RE, 'The server') });
}
