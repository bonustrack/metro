import {
  AwsError,
  consoleOutput,
  describeInstance,
  describeZones,
  INSTANCE_TYPE,
  latestUbuntuArm64Image,
  runInstance,
  type AwsCredentials,
  type InstanceSpec,
  type InstanceState,
} from './ec2.js';
import { metroSetupLines, progressOf, type Progress } from './boot-log.js';
import { hostOf, randomNodeName, slugOf } from './names.js';
import { cloudInit } from './user-data.js';

export const METRO_TAG = 'beta';
export const NO_CAPACITY = 'InsufficientInstanceCapacity';
const TSKEY = /tskey-[A-Za-z0-9_-]+/g;

export interface LaunchInput {
  name: string;
  region: string;
  owner: string;
  tailnet: string;
  authKey: string;
  credentials: AwsCredentials;
}

export interface Launched {
  host: string;
  node: string;
  instanceId: string;
  region: string;
  zone: string | null;
  imageId: string;
}

export interface LaunchDeps {
  latestImage: (credentials: AwsCredentials, region: string) => Promise<string>;
  run: (credentials: AwsCredentials, region: string, spec: InstanceSpec) => Promise<string>;
  zones: (credentials: AwsCredentials, region: string) => Promise<string[]>;
  node: () => string;
  token: () => string;
}

export const LIVE: LaunchDeps = {
  latestImage: async (credentials, region) => (await latestUbuntuArm64Image(credentials, region)).imageId,
  run: runInstance,
  zones: describeZones,
  node: randomNodeName,
  token: () => crypto.randomUUID(),
};

export class LaunchError extends Error {}

const noCapacity = (err: unknown): boolean => err instanceof AwsError && err.code === NO_CAPACITY;

type Spec = Omit<InstanceSpec, 'clientToken' | 'zone'>;

interface Placed {
  instanceId: string;
  zone: string | null;
}

async function tryZones(
  input: LaunchInput,
  deps: LaunchDeps,
  spec: Spec,
  zones: string[],
  all: string[],
): Promise<Placed> {
  const [zone, ...rest] = zones;
  if (zone === undefined)
    throw new LaunchError(
      `AWS has no ${INSTANCE_TYPE} capacity in ${input.region} right now, in any of its zones (${all.join(', ')}). Try again in a few minutes, or pick another region.`,
    );
  try {
    const instanceId = await deps.run(input.credentials, input.region, { ...spec, zone, clientToken: deps.token() });
    return { instanceId, zone };
  } catch (err) {
    if (!noCapacity(err)) throw err;
    return tryZones(input, deps, spec, rest, all);
  }
}

async function place(input: LaunchInput, deps: LaunchDeps, spec: Spec): Promise<Placed> {
  try {
    const instanceId = await deps.run(input.credentials, input.region, { ...spec, clientToken: deps.token() });
    return { instanceId, zone: null };
  } catch (err) {
    if (!noCapacity(err)) throw err;
  }
  const zones = await deps.zones(input.credentials, input.region);
  return tryZones(input, deps, spec, zones, zones);
}

export async function launchBox(input: LaunchInput, deps: LaunchDeps = LIVE): Promise<Launched> {
  const slug = slugOf(input.name);
  if (slug === '') throw new LaunchError('Give the server a name with at least one letter or digit.');
  const node = deps.node();
  const userData = cloudInit({
    hostname: slug,
    node,
    owner: input.owner.toLowerCase(),
    tailscaleAuthKey: input.authKey,
    metroTag: METRO_TAG,
  });
  const imageId = await deps.latestImage(input.credentials, input.region);
  const { instanceId, zone } = await place(input, deps, { imageId, name: input.name, node, userData });
  return { host: hostOf(node, input.tailnet), node, instanceId, region: input.region, zone, imageId };
}

export const redactKeys = (text: string): string => text.replace(TSKEY, 'tskey-REDACTED');

export interface BootView extends Progress {
  lines: string[];
  at: string | null;
}

export async function bootView(
  credentials: AwsCredentials,
  region: string,
  instanceId: string,
): Promise<BootView> {
  const output = await consoleOutput(credentials, region, instanceId);
  const log = metroSetupLines(redactKeys(output.text));
  return { ...progressOf(log), lines: log.lines, at: output.at };
}

export const instanceStateOf = (
  credentials: AwsCredentials,
  region: string,
  instanceId: string,
): Promise<InstanceState> => describeInstance(credentials, region, instanceId);
