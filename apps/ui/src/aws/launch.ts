import { addServer, type Server } from '../api/servers.js';
import {
  AwsError,
  consoleOutput,
  describeInstance,
  describeZones,
  INSTANCE_TYPE,
  latestUbuntuArm64Image,
  runInstance,
  type AwsCredentials,
  type ConsoleOutput,
  type Image,
  type InstanceSpec,
  type InstanceState,
} from './ec2.js';
import { cloudInit } from './user-data.js';
import { hostOf, randomNodeName, recordLaunch, slugOf, type Launch } from './settings.js';

export const METRO_TAG = 'beta';
export const NO_CAPACITY = 'InsufficientInstanceCapacity';

export interface LaunchInput {
  name: string;
  region: string;
  credentials: AwsCredentials;
  tailscaleAuthKey: string;
  tailnet: string;
  owner: string;
}

export interface Launched {
  host: string;
  node: string;
  instanceId: string;
  region: string;
  zone: string | null;
  image: Image;
  server: Server;
  launchedAt: string;
}

export interface LaunchDeps {
  latestImage: (credentials: AwsCredentials, region: string) => Promise<Image>;
  run: (credentials: AwsCredentials, region: string, spec: InstanceSpec) => Promise<string>;
  zones: (credentials: AwsCredentials, region: string) => Promise<string[]>;
  add: (host: string, name: string) => Promise<Server>;
  record: (host: string, launch: Launch) => void;
  now: () => Date;
  token: () => string;
  node: () => string;
}

const LIVE: LaunchDeps = {
  latestImage: latestUbuntuArm64Image,
  run: runInstance,
  zones: describeZones,
  add: addServer,
  record: recordLaunch,
  now: () => new Date(),
  token: () => crypto.randomUUID(),
  node: randomNodeName,
};

export function plannedHost(name: string, tailnet: string, node: string): { slug: string; node: string; host: string } {
  const slug = slugOf(name);
  if (slug === '') throw new Error('Give the server a name with at least one letter or digit.');
  const suffix = tailnet.trim().toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)*ts\.net$/.test(suffix)) throw new Error('The tailnet is the part after the machine name, as in tail1234.ts.net.');
  return { slug, node, host: hostOf(node, suffix) };
}

const noCapacity = (err: unknown): boolean => err instanceof AwsError && err.code === NO_CAPACITY;

interface Placed {
  instanceId: string;
  zone: string | null;
}

type Spec = Omit<InstanceSpec, 'clientToken' | 'zone'>;

async function tryZones(input: LaunchInput, deps: LaunchDeps, spec: Spec, zones: string[], all: string[]): Promise<Placed> {
  const [zone, ...rest] = zones;
  if (zone === undefined)
    throw new Error(
      `AWS has no ${INSTANCE_TYPE} capacity in ${input.region.trim()} right now, in any of its zones (${all.join(', ')}). Try again in a few minutes, or pick another region.`,
    );
  try {
    return { instanceId: await deps.run(input.credentials, input.region.trim(), { ...spec, zone, clientToken: deps.token() }), zone };
  } catch (err) {
    if (!noCapacity(err)) throw err;
    return tryZones(input, deps, spec, rest, all);
  }
}

async function place(input: LaunchInput, deps: LaunchDeps, spec: Spec): Promise<Placed> {
  const region = input.region.trim();
  try {
    return { instanceId: await deps.run(input.credentials, region, { ...spec, clientToken: deps.token() }), zone: null };
  } catch (err) {
    if (!noCapacity(err)) throw err;
  }
  const zones = await deps.zones(input.credentials, region);
  return tryZones(input, deps, spec, zones, zones);
}

export async function launchBox(input: LaunchInput, deps: LaunchDeps = LIVE): Promise<Launched> {
  const name = input.name.trim();
  const region = input.region.trim();
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('The region is an AWS region name, as in eu-west-1.');
  const { slug, node, host } = plannedHost(name, input.tailnet, deps.node());
  const userData = cloudInit({ hostname: slug, node, owner: input.owner.toLowerCase(), tailscaleAuthKey: input.tailscaleAuthKey.trim(), metroTag: METRO_TAG });
  const image = await deps.latestImage(input.credentials, region);
  const { instanceId, zone } = await place(input, deps, { imageId: image.imageId, name, node, userData });
  const server = await deps.add(host, name);
  const launchedAt = deps.now().toISOString();
  deps.record(host, { instanceId, region, name, launchedAt });
  return { host, node, instanceId, region, zone, image, server, launchedAt };
}

export const IAM_POLICY = JSON.stringify(
  {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          'ec2:DescribeRegions',
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeImages',
          'ec2:DescribeInstances',
          'ec2:RunInstances',
          'ec2:CreateTags',
          'ec2:GetConsoleOutput',
        ],
        Resource: '*',
      },
    ],
  },
  null,
  2,
);

export const instanceState = (credentials: AwsCredentials, launch: Launch): Promise<InstanceState> =>
  describeInstance(credentials, launch.region, launch.instanceId);

export const bootLog = (credentials: AwsCredentials, launch: Launch): Promise<ConsoleOutput> =>
  consoleOutput(credentials, launch.region, launch.instanceId);
