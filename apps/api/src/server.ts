import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import { handleModeRequest, type ModeInfo } from '@metro-labs/http/mode-api';
import { clientId, jwksUrl, SigningKeys, workosBase } from '@metro-labs/http/workos-token';
import { handleAuthApiRequest } from './auth/routes.js';
import { handleMembersApiRequest } from './auth/members.js';
import { handleAdminApiRequest, type AdminApiDeps } from './admin.js';
import { readWorkosConfig } from './auth/workos.js';
import {
  addLaunchedServer,
  addServerForOwner,
  deleteServerForOwner,
  deleteServerRow,
  deletionRowById,
  deletionRowForOwner,
  instanceForOwner,
  launchForOwner,
  listAllServers,
  listServersForOwner,
  renameServerForOwner,
  setAvatarForOwner, moveServerForOwner } from './db/servers.js';
import { announceLaunchConfig, readLaunchConfig } from './launch-config.js';
import { bootView, instanceStateOf, launchBox } from './aws/launch.js';
import { describeInstanceTypes, describeRegions } from './aws/ec2.js';
import { access } from './aws/access.js';
import { callerIdentity } from './aws/sts.js';
import { publishTemplate, templatesOf } from './aws/templates.js';
import { describeInstanceFacts, listInstances, tagInstance } from './aws/teardown.js';
import { dbAws, metroServers } from './db/aws.js';
import { handleAwsConnectionsRequest, type AwsConnectionsDeps } from './aws-connections.js';
import { handleServerLinkRequest, type ServerLinkDeps } from './server-link.js';
import { roleCheck } from './admin-aws.js';
import { gbMonthPrice, hourlyPrice } from './aws/pricing.js';
import { LIVE_RESIZE } from './aws/resize.js';
import { LIVE_DELETION } from './aws/deletion.js';
import { LIVE_GROW } from './aws/grow.js';
import { handleLaunchApiRequest, type LaunchApiDeps } from './launch.js';
import { handleSizeApiRequest, resizing, type SizeApiDeps } from './size.js';
import { handleDeletionApiRequest, type DeletionApiDeps } from './deletion.js';
import { growing, handleStorageApiRequest, type StorageApiDeps } from './storage.js';
import { handleServersApiRequest, type ServersApiDeps } from './servers.js';
import { handleGmailApiRequest } from './gmail/api.js';
import { GmailBroker, gmailStateStore } from './gmail/broker.js';
import { readGmailConfig } from './gmail/config.js';
import { gmailUserAllowed } from './gmail/authorization.js';
import { handleUsageApiRequest, LIVE_METRICS, type MetricsCore, type UsageApiDeps } from './usage.js';
import { handleLatestApiRequest, type LatestApiDeps } from './usage-latest.js';
import { usageRowForOwner, usageRowsForOwner } from './db/usage.js';
import { dbSlugs } from './db/organizations.js';
import { dbUsers } from './db/users.js';
import { getDb } from './db/client.js';
import { boxKeyStore } from './db/boxes.js';
import { BoxAuth } from './boxes/auth.js';
import { enrollTickets, handleEnrollmentRequest, type EnrollmentDeps } from './boxes/enrollment.js';
import { announceConnectorsSetup, readConnectorsSetup } from './connectors/setup.js';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.METRO_WEBHOOK_PORT) || 8420;
const HOST = process.env.METRO_HTTP_HOST ?? '127.0.0.1';

const mode = (): ModeInfo => ({ mode: 'hosted', owner: null, version: METRO_VERSION });
const keys = new SigningKeys(jwksUrl(clientId(), workosBase()));
const authApi = { config: () => readWorkosConfig(), keys, slugs: dbSlugs, users: dbUsers, agentsOf: listServersForOwner };
const gmailApi = {
  keys,
  broker: new GmailBroker({
    config: () => readWorkosConfig() === null ? null : readGmailConfig(),
    states: gmailStateStore(),
    fetch: (url, init) => fetch(url, init),
    list: listServersForOwner,
    allowed: (userId, organization) => gmailUserAllowed(dbUsers, readWorkosConfig(), userId, organization),
    now: () => Date.now(),
  }),
};
const changing = (region: string, instanceId: string): boolean => resizing(region, instanceId) || growing(region, instanceId);
const deletionCore = { config: () => readLaunchConfig(), resizing: changing, aws: LIVE_DELETION };
const metricsCore: MetricsCore = { config: () => readLaunchConfig(), aws: LIVE_METRICS, now: () => Date.now() };
const awsCheck = (): Promise<unknown> => roleCheck({ config: () => readLaunchConfig(), servers: metroServers, access, caller: callerIdentity, describe: describeInstanceFacts });
const adminApi: AdminApiDeps = { ...authApi, agents: listAllServers, deletion: { ...deletionCore, lookup: deletionRowById, remove: deleteServerRow }, awsCheck };
const usageApi: UsageApiDeps = { ...metricsCore, lookup: usageRowForOwner, keys };
const latestApi: LatestApiDeps = { ...metricsCore, rows: usageRowsForOwner, keys };
const serversApi: ServersApiDeps = {
  list: listServersForOwner,
  add: addServerForOwner,
  rename: renameServerForOwner,
  remove: deleteServerForOwner,
  avatar: setAvatarForOwner,
  move: (session, id, body) => moveServerForOwner(session, id, body, readWorkosConfig()),
  keys,
};
const launchApi: LaunchApiDeps = {
  config: () => readLaunchConfig(),
  launch: (input) => launchBox(input),
  regions: describeRegions,
  state: instanceStateOf,
  boot: bootView,
  record: addLaunchedServer,
  lookup: launchForOwner,
  now: () => Date.now(),
  keys,
};

const sizeApi: SizeApiDeps = {
  config: () => readLaunchConfig(),
  lookup: instanceForOwner,
  aws: LIVE_RESIZE,
  sizes: { types: describeInstanceTypes, price: hourlyPrice, now: () => Date.now() },
  growing,
  keys,
};

const storageApi: StorageApiDeps = {
  config: () => readLaunchConfig(),
  lookup: deletionRowForOwner,
  aws: LIVE_GROW,
  price: gbMonthPrice,
  resizing,
  keys,
};

const deletionApi: DeletionApiDeps = { ...deletionCore, lookup: deletionRowForOwner, remove: deleteServerForOwner, keys };

const awsApi: AwsConnectionsDeps = {
  config: () => readLaunchConfig(),
  templates: () => templatesOf(process.env.METRO_AWS_TEMPLATES ?? ''),
  store: dbAws,
  access,
  aws: { caller: callerIdentity, regions: describeRegions, instances: listInstances, publish: publishTemplate },
  externalId: () => randomBytes(24).toString('base64url'),
  now: () => Date.now(),
  keys,
};

const connectorsSetup = readConnectorsSetup();

const enrollmentApi: EnrollmentDeps = {
  enabled: () => connectorsSetup.enabled,
  keys,
  tickets: enrollTickets(),
  store: boxKeyStore(getDb),
  auth: new BoxAuth(() => Date.now()),
  now: () => Date.now(),
};

const linkApi: ServerLinkDeps = {
  config: () => readLaunchConfig(),
  lookup: deletionRowForOwner,
  store: dbAws,
  access,
  aws: { describe: describeInstanceFacts, tag: tagInstance },
  keys,
};

function handleHealth(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/health' && path !== '/healthz') return false;
  res
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ status: 'ok', version: METRO_VERSION, uptime: Math.round(process.uptime()) }));
  return true;
}

const HANDLERS: ((req: IncomingMessage, res: ServerResponse) => boolean)[] = [
  handleHealth,
  (req, res) => handleModeRequest(req, res, mode),
  (req, res) => handleAuthApiRequest(req, res, authApi),
  (req, res) => handleMembersApiRequest(req, res, authApi),
  (req, res) => handleAdminApiRequest(req, res, adminApi),
  (req, res) => handleSizeApiRequest(req, res, sizeApi),
  (req, res) => handleStorageApiRequest(req, res, storageApi),
  (req, res) => handleDeletionApiRequest(req, res, deletionApi),
  (req, res) => handleUsageApiRequest(req, res, usageApi),
  (req, res) => handleServerLinkRequest(req, res, linkApi),
  (req, res) => handleAwsConnectionsRequest(req, res, awsApi),
  (req, res) => handleLatestApiRequest(req, res, latestApi),
  (req, res) => handleGmailApiRequest(req, res, gmailApi),
  (req, res) => handleEnrollmentRequest(req, res, enrollmentApi),
  (req, res) => handleServersApiRequest(req, res, serversApi),
  (req, res) => handleLaunchApiRequest(req, res, launchApi),
];

export function handleApiRequest(req: IncomingMessage, res: ServerResponse): void {
  if (HANDLERS.some((handle) => handle(req, res))) return;
  res.writeHead(404).end();
}

const server = createServer((req, res) => {
  try {
    handleApiRequest(req, res);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'api: request failed');
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(PORT, HOST, () => {
  announceLaunchConfig(readLaunchConfig());
  announceConnectorsSetup(connectorsSetup);
  log.info({ signIn: readWorkosConfig() === null ? 'off: WORKOS_API_KEY or WORKOS_CLIENT_ID is unset' : 'on', clientId: clientId() }, 'api: sign-in');
  log.info({ host: HOST, port: PORT, version: METRO_VERSION }, 'api ready');
});
