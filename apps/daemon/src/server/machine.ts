import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname, homedir } from 'node:os';
import { statfs } from 'node:fs/promises';
import { errMsg, log } from '@metro-labs/core/log';
import { sessionRoute } from '@metro-labs/http/api-http';
import { publicBaseUrl, webhookPort } from '../files/attach-serve.js';
import { claudeDir } from '../claude/files.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import { agentsDir } from '../agents/files.js';
import { localOwner } from '../agents/file-admin.js';

const PATH = '/api/server';

export interface MachineApiDeps {
  startedAt?: string;
  resources?: (range: string) => unknown;
}

const bootedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

interface Disk {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export async function diskInfo(path = homedir()): Promise<Disk | null> {
  try {
    const s = await statfs(path);
    return { path, totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
  } catch (err) {
    log.warn({ err: errMsg(err), path }, 'machine: could not read the disk');
    return null;
  }
}

export async function machineInfo(startedAt = bootedAt): Promise<Record<string, unknown>> {
  const store = process.env.METRO_RUNTIME_STORE?.trim() ?? '';
  return {
    disk: await diskInfo(),
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
  return sessionRoute(req, res, { methods: { [PATH]: ['GET'] }, admin: false, label: 'machine-api' }, async () => {
    const info = await machineInfo(deps.startedAt);
    const range = new URL(req.url ?? '', 'http://localhost').searchParams.get('range');
    return range === null || deps.resources === undefined ? info : { ...info, resources: deps.resources(range) };
  });
}
