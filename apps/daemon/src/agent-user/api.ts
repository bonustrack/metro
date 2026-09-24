import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField, readJsonBody, sessionRoute } from '@metro-labs/http/api-http';
import { log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { agentUser, CONFIG_FILE, forgetAgentUser, wantedAgentUser } from './user.js';

const PATH = '/api/agent-user';
const EXIT_DELAY_MS = 500;

export interface AgentUserApiDeps {
  restart: () => void;
  agents?: () => string;
  host?: () => { platform: string; uid: number | undefined; cli: boolean };
}

export interface AgentUserStatus {
  enabled: boolean;
  user: string | null;
  active: boolean;
  supported: boolean;
  reason: string | null;
}

const realHost = (): { platform: string; uid: number | undefined; cli: boolean } => ({
  platform: process.platform,
  uid: process.getuid?.(),
  cli: (process.env.METRO_CLI_BIN?.trim() ?? '') !== '',
});

function unsupported(host: { platform: string; uid: number | undefined; cli: boolean }): string | null {
  if (host.platform !== 'linux') return 'Claude Code can run as its own user on Linux only.';
  if (host.uid !== 0) return 'Metro runs as a normal user here, so it cannot switch Claude Code to another user.';
  if (!host.cli) return 'This daemon was not started by metro serve, so nothing would bring it back after the switch.';
  return null;
}

export function agentUserStatus(deps: Pick<AgentUserApiDeps, 'agents' | 'host'> = {}): AgentUserStatus {
  const dir = (deps.agents ?? agentsDir)();
  const reason = unsupported((deps.host ?? realHost)());
  const user = wantedAgentUser(dir);
  return { enabled: user !== null, user, active: user !== null && agentUser(dir) !== null, supported: reason === null, reason };
}

function setWanted(dir: string, enabled: boolean): void {
  const path = join(dir, CONFIG_FILE);
  if (enabled) writeSecure(path, `${JSON.stringify({ user: 'agent' })}\n`);
  else if (existsSync(path)) rmSync(path);
  forgetAgentUser();
}

export function handleAgentUserRequest(req: IncomingMessage, res: ServerResponse, deps: AgentUserApiDeps): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'POST'] }, admin: ['POST'], label: 'agent-user-api' }, async (session) => {
    if (req.method === 'GET') return agentUserStatus(deps);
    const enabled = bodyField(await readJsonBody(req), 'enabled');
    if (typeof enabled !== 'boolean') throw new ApiError('enabled must be true or false', 400);
    const reason = unsupported((deps.host ?? realHost)());
    if (enabled && reason !== null) throw new ApiError(reason, 400);
    const dir = (deps.agents ?? agentsDir)();
    setWanted(dir, enabled);
    log.info({ enabled, subject: session.subject }, 'agent-user-api: switched from the page; restarting');
    setTimeout(deps.restart, EXIT_DELAY_MS).unref();
    return { ...agentUserStatus(deps), restarting: true };
  });
}
