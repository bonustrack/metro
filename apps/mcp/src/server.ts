import { createServer } from 'node:http';
import { errMsg, log, logFatalSync } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import { egressFetch } from '@metro-labs/connectors/egress';
import { handleRequest, mcpDeps } from './app.js';
import { readMcpConfig, type McpConfig } from './config.js';
import { connectDb } from './db.js';
import { MCP_BODY_MAX } from './mcp-http.js';
import { startApprovalPruning } from './prune.js';
import { VENDOR_CALL_MS } from './vendor.js';

function configOrExit(): McpConfig {
  try {
    return readMcpConfig();
  } catch (err) {
    logFatalSync({ err: errMsg(err) }, 'mcp: refusing to start');
    return process.exit(1);
  }
}

const config = configOrExit();
const db = connectDb(config.databaseUrl);
const deps = mcpDeps({
  key: config.key,
  db: () => db,
  publicHost: config.publicHost,
  fetch: egressFetch(),
  callFetch: egressFetch(undefined, { bodyMax: 2 * MCP_BODY_MAX, idleMs: VENDOR_CALL_MS }),
});

const server = createServer((req, res) => {
  try {
    handleRequest(req, res, deps);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'mcp: request failed');
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(config.port, config.host, () => {
  log.info({ host: config.host, port: config.port, publicHost: config.publicHost, version: METRO_VERSION }, 'mcp ready');
});

startApprovalPruning(() => db);
