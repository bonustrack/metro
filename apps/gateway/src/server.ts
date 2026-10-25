import { createServer } from 'node:http';
import { errMsg, log, logFatalSync } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import { quietProviderText } from '@metro-labs/inference/failures';
import { handleRequest, type GatewayAppDeps } from './app.js';
import { callerLookup } from './callers.js';
import { readGatewayConfig, type GatewayConfig } from './config.js';
import { connectDb } from './db.js';
import { RoutewayPrices } from './prices.js';
import { CallLog } from './recorder.js';
import { Setups } from './setups.js';
import { WindowSaver } from './windows.js';

function configOrExit(): GatewayConfig {
  try {
    return readGatewayConfig();
  } catch (err) {
    logFatalSync({ err: errMsg(err) }, 'gateway: refusing to start');
    return process.exit(1);
  }
}

quietProviderText();
const config = configOrExit();
const db = connectDb(config.databaseUrl);
const deps: GatewayAppDeps = {
  callerOf: callerLookup(() => db),
  setups: new Setups({ db: () => db, key: config.key, fetch, now: Date.now }),
  calls: new CallLog(() => db),
  windows: new WindowSaver(() => db),
  routeway: new RoutewayPrices(fetch),
  now: Date.now,
};

const server = createServer((req, res) => {
  try {
    handleRequest(req, res, deps);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'gateway: request failed');
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(config.port, config.host, () => {
  log.info({ host: config.host, port: config.port, version: METRO_VERSION }, 'gateway ready');
});

deps.windows.start();
deps.routeway.refresh();

const shutdown = (): void => {
  deps.windows.stop();
  deps.calls.drain().then(
    () => process.exit(0),
    () => process.exit(0),
  );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
