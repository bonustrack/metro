import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField, readJsonBody, requireAdmin, sessionRoute } from '@metro-labs/http/api-http';
import { log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { agentUser, CONFIG_FILE, forgetAgentUser, wantedAgentUser } from './user.js';
import { listWorkspace, startMove } from './workspace.js';

const PATH = '/api/agent-user';
const WORKSPACE = '/api/agent-user/workspace';
const EXIT_DELAY_MS = 500;
const NAMES_BODY_MAX = 128 * 1024;

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

async function workspaceAnswer(req: IncomingMessage, dir: string): Promise<unknown> {
  const user = agentUser(dir);
  if (user === null) throw new ApiError('switch Claude Code to its own user first', 409);
  if (req.method === 'GET') return { user: user.name, home: user.home, entries: listWorkspace(user) };
  const started = startMove(bodyField(await readJsonBody(req, NAMES_BODY_MAX), 'names'), user);
  return { started, entries: listWorkspace(user) };
}

export function handleAgentUserRequest(req: IncomingMessage, res: ServerResponse, deps: AgentUserApiDeps): boolean {
  const methods = { [PATH]: ['GET', 'POST'], [WORKSPACE]: ['GET', 'POST'] };
  return sessionRoute(req, res, { methods, admin: ['POST'], label: 'agent-user-api' }, async (session, path) => {
    if (path === WORKSPACE) {
      requireAdmin(session);
      return workspaceAnswer(req, (deps.agents ?? agentsDir)());
    }
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
