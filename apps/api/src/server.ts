import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import { handleModeRequest, type ModeInfo } from '@metro-labs/http/mode-api';
import {
  addLaunchedServer,
  addServerForOwner,
  deleteServerForOwner,
  launchForOwner,
  listServersForOwner,
  renameServerForOwner,
} from './db/servers.js';
import { announceLaunchConfig, readLaunchConfig } from './launch-config.js';
import { bootView, instanceStateOf, launchBox } from './aws/launch.js';
import { describeRegions } from './aws/ec2.js';
import { handleLaunchApiRequest, type LaunchApiDeps } from './launch.js';
import { handleServersApiRequest } from './servers.js';

const PORT = Number(process.env.METRO_WEBHOOK_PORT) || 8420;
const HOST = process.env.METRO_HTTP_HOST ?? '127.0.0.1';

const mode = (): ModeInfo => ({ mode: 'hosted', owner: null, project: null, version: METRO_VERSION });
const serversApi = { list: listServersForOwner, add: addServerForOwner, rename: renameServerForOwner, remove: deleteServerForOwner };
const launchApi: LaunchApiDeps = {
  config: () => readLaunchConfig(),
  launch: (input) => launchBox(input),
  regions: describeRegions,
  state: instanceStateOf,
  boot: bootView,
  record: addLaunchedServer,
  lookup: launchForOwner,
  now: () => Date.now(),
};

function handleHealth(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/health' && path !== '/healthz') return false;
  res
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ status: 'ok', version: METRO_VERSION, uptime: Math.round(process.uptime()) }));
  return true;
}

export function handleApiRequest(req: IncomingMessage, res: ServerResponse): void {
  if (handleHealth(req, res)) return;
  if (handleModeRequest(req, res, mode)) return;
  if (handleServersApiRequest(req, res, serversApi)) return;
  if (handleLaunchApiRequest(req, res, launchApi)) return;
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
  log.info({ host: HOST, port: PORT, version: METRO_VERSION }, 'api ready');
});
