import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, cors, sendJson } from '@metro-labs/http/api-http';
import { publicBaseUrl } from '../files/attach-serve.js';
import { claudeDir } from '../claude/files.js';
import { webhookPort } from '../net/tunnel.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import { agentsDir } from '../agents/files.js';
import { localOwner } from '../agents/file-admin.js';

const PATH = '/api/server';

export interface MachineApiDeps {
  authorize: (subject: string) => void;
  startedAt?: string;
}

const bootedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function machineInfo(startedAt = bootedAt): Record<string, unknown> {
  const store = process.env.METRO_RUNTIME_STORE?.trim() ?? '';
  return {
    version: METRO_VERSION,
    owner: localOwner(),
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    port: webhookPort(),
    publicUrl: publicBaseUrl(),
    uptimeSeconds: Math.round(process.uptime()),
    startedAt,
    bun: process.versions.bun ?? null,
    agentsDir: agentsDir(),
    claudeDir: claudeDir(),
    runtimeStore: store === '' ? null : store,
  };
}

export function handleMachineRequest(req: IncomingMessage, res: ServerResponse, deps: MachineApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then((session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      deps.authorize(session.subject);
      sendJson(req, res, 200, machineInfo(deps.startedAt));
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'machine-api');
    });
  return true;
}
