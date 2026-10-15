import { log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import { readClaudeLogins, type ClaudeLogin } from './claude-store.js';
import type { Delivered } from './delivered.js';
import { emptySetup, LOCAL_PREFIX, loginConnection, primaryRoute, runnerModel, SESSION_LOGIN, sessionConnection, type Connection, type ModelSetup } from './model-config.js';
import { deliveredSetup, type OrgModels } from './org-models.js';

function localOf(id: string, logins: ClaudeLogin[]): Connection | null {
  if (id === SESSION_LOGIN) return sessionConnection();
  if (!id.startsWith(LOCAL_PREFIX)) return null;
  const login = id.slice(LOCAL_PREFIX.length);
  return loginConnection(login, logins.find((l) => l.id === login));
}

export function setupOf(delivered: Delivered | null, logins: ClaudeLogin[]): ModelSetup {
  const route = delivered?.route ?? null;
  if (delivered === null || route === null) return { ...emptySetup(), source: delivered?.source ?? null };
  const named = [...(route.primary === null ? [] : [route.primary]), ...route.fallbacks].map((r) => r.connection);
  const locals = [...new Set(named)].flatMap((id) => localOf(id, logins) ?? []);
  return { primary: route.primary, fallbacks: route.fallbacks, connections: [...delivered.connections, ...locals], source: delivered.source };
}

export const effectiveSetup = (dir = agentsDir(), delivered: Delivered | null = deliveredSetup()): ModelSetup => setupOf(delivered, readClaudeLogins(dir));

export function modelViewText(setup: ModelSetup): string | null {
  const primary = primaryRoute(setup);
  if (primary === null) return null;
  const connections = [{ id: primary.connection.id, provider: primary.connection.provider, model: primary.model }];
  return `${JSON.stringify({ version: 2, route: primary.connection.id, connections }, null, 2)}\n`;
}

export function watchModelChanges(models: Pick<OrgModels, 'onChange'>, switchModel: (model: string | null) => boolean, setup: () => ModelSetup = effectiveSetup): () => void {
  let last = runnerModel(setup());
  const changed = (): void => {
    const now = runnerModel(setup());
    if (now === last) return;
    const was = last;
    last = now;
    if (switchModel(now)) log.info({ was, now }, 'org-models: the model changed, so the Agent SDK session switches to it live, with no restart');
    else log.info({ was, now }, 'org-models: the model changed while no Agent SDK session listens; its next start loads it');
  };
  return models.onChange(changed);
}
