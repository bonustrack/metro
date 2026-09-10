import { addServer, type Server } from '../api/servers.js';
import { describeInstance, latestUbuntuArm64Image, runInstance, type AwsCredentials, type Image, type InstanceSpec, type InstanceState } from './ec2.js';
import { cloudInit } from './user-data.js';
import { hostOf, nodeNameOf, recordLaunch, slugOf, type Launch } from './settings.js';

export const METRO_TAG = 'beta';

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
  image: Image;
  server: Server;
}

export interface LaunchDeps {
  latestImage: (credentials: AwsCredentials, region: string) => Promise<Image>;
  run: (credentials: AwsCredentials, region: string, spec: InstanceSpec) => Promise<string>;
  add: (host: string, name: string) => Promise<Server>;
  record: (host: string, launch: Launch) => void;
  now: () => Date;
  token: () => string;
}

const LIVE: LaunchDeps = {
  latestImage: latestUbuntuArm64Image,
  run: runInstance,
  add: addServer,
  record: recordLaunch,
  now: () => new Date(),
  token: () => crypto.randomUUID(),
};

export function plannedHost(name: string, tailnet: string): { slug: string; node: string; host: string } {
  const slug = slugOf(name);
  if (slug === '') throw new Error('Give the server a name with at least one letter or digit.');
  const node = nodeNameOf(slug);
  const suffix = tailnet.trim().toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)*ts\.net$/.test(suffix)) throw new Error('The tailnet is the part after the machine name, as in tail1234.ts.net.');
  return { slug, node, host: hostOf(node, suffix) };
}

export async function launchBox(input: LaunchInput, deps: LaunchDeps = LIVE): Promise<Launched> {
  const name = input.name.trim();
  const region = input.region.trim();
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('The region is an AWS region name, as in eu-west-1.');
  const { slug, node, host } = plannedHost(name, input.tailnet);
  const userData = cloudInit({ hostname: slug, node, owner: input.owner.toLowerCase(), tailscaleAuthKey: input.tailscaleAuthKey.trim(), metroTag: METRO_TAG });
  const image = await deps.latestImage(input.credentials, region);
  const instanceId = await deps.run(input.credentials, region, { imageId: image.imageId, name, node, userData, clientToken: deps.token() });
  const server = await deps.add(host, name);
  deps.record(host, { instanceId, region, name, launchedAt: deps.now().toISOString() });
  return { host, node, instanceId, image, server };
}

export const IAM_POLICY = JSON.stringify(
  {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ec2:DescribeImages', 'ec2:DescribeInstances', 'ec2:RunInstances', 'ec2:CreateTags'],
        Resource: '*',
      },
    ],
  },
  null,
  2,
);

export const instanceState = (credentials: AwsCredentials, launch: Launch): Promise<InstanceState> =>
  describeInstance(credentials, launch.region, launch.instanceId);
