import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField, readJsonBody, sessionRoute } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { sessionRunning, stopSession } from '../claude/session.js';
import { agentUser } from '../agent-user/user.js';
import { applyVault, vaultStatus } from './index.js';
import { recentRequests } from './proxy.js';
import { addSecret, readVault, removeSecret, setVaultEnabled, updateSecret, type SecretInput } from './store.js';

const PATH = '/api/vault';

function view(): unknown {
  return { ...vaultStatus(), secrets: readVault().secrets, recent: recentRequests().slice(0, 100) };
}

const inputOf = (body: unknown): SecretInput => (isRecord(body) ? { name: body.name, env: body.env, hosts: body.hosts, value: body.value } : {});

function change(body: unknown): void {
  const action = bodyField(body, 'action');
  const id = bodyField(body, 'id');
  if (action === 'enable' || action === 'disable') {
    if (agentUser() === null) throw new ApiError('the vault needs Claude Code running as its own user (a Linux box)', 409);
    setVaultEnabled(action === 'enable');
  } else if (action === 'add') addSecret(inputOf(body));
  else if (action === 'update' && typeof id === 'string') updateSecret(id, inputOf(body));
  else if (action === 'remove' && typeof id === 'string') removeSecret(id);
  else throw new ApiError('action must be enable, disable, add, update or remove', 400);
}

async function answer(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET') return view();
  change(await readJsonBody(req));
  const { envChanged } = await applyVault();
  if (envChanged && sessionRunning()) {
    stopSession();
    log.info('vault: the Claude session restarts to pick up the new environment');
  }
  return view();
}

export function handleVaultRequest(req: IncomingMessage, res: ServerResponse): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'POST'] }, admin: true, label: 'vault-api' }, () => answer(req));
}
