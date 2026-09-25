import { writeFileSync } from 'node:fs';
import { errMsg, log } from '@metro-labs/core/log';
import { ensureSecureDir } from '@metro-labs/core/secure-fs';
import { agentExtraEnv, agentUser, asAgent, setAgentExtraEnv, type AgentUser } from '../agent-user/user.js';
import { spawnSync } from 'node:child_process';
import { exportJobEnv } from '../agent-user/job-env.js';
import { proxyConfig, proxyEnvFor } from './config.js';
import { applyFirewall, removeFirewall } from './firewall.js';
import { ensureAuthority, ensureProxyBinary } from './install.js';
import { configFile, PROXY_VERSION, SYSTEM_BUNDLE, TRUSTED_CA, vaultDir } from './paths.js';
import { proxyError, proxyRunning, runProxy, stopProxy } from './proxy.js';
import { hasValue, readVault } from './store.js';
import { trustBrowsers, trustSystem, untrustSystem } from './trust.js';

export interface VaultStatus {
  available: boolean;
  enabled: boolean;
  running: boolean;
  version: string;
  problem: string | null;
  browsers: string | null;
}

const memory: { problem: string | null; browsers: string | null } = { problem: null, browsers: null };

function pushTmuxEnv(before: Record<string, string>, after: Record<string, string>): void {
  const has = spawnSync(...asAgent('tmux', ['list-sessions']), { stdio: 'ignore' }).status === 0;
  if (!has) return;
  for (const key of Object.keys(before)) if (!(key in after)) spawnSync(...asAgent('tmux', ['set-environment', '-gu', key]), { stdio: 'ignore' });
  for (const [key, value] of Object.entries(after)) spawnSync(...asAgent('tmux', ['set-environment', '-g', key, value]), { stdio: 'ignore' });
}

const sameEnv = (a: Record<string, string>, b: Record<string, string>): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function setEnv(next: Record<string, string>): boolean {
  const before = agentExtraEnv();
  if (sameEnv(before, next)) return false;
  setAgentExtraEnv(next);
  pushTmuxEnv(before, next);
  return true;
}

function exportForJobs(user: AgentUser, env: Record<string, string>): void {
  try {
    exportJobEnv(user, env);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'vault: could not give the scheduled jobs the vault settings');
  }
}

async function turnOn(user: AgentUser, dir: string): Promise<Record<string, string>> {
  const bin = await ensureProxyBinary(dir);
  const ca = ensureAuthority(bin, dir);
  const secrets = readVault(dir).secrets.filter((s) => hasValue(s.id, dir));
  ensureSecureDir(dir);
  writeFileSync(configFile(dir), JSON.stringify(proxyConfig(secrets, dir), null, 2), { mode: 0o600 });
  trustSystem(ca);
  memory.browsers = trustBrowsers(user);
  await runProxy(bin, configFile(dir));
  applyFirewall();
  return proxyEnvFor(TRUSTED_CA, SYSTEM_BUNDLE, secrets);
}

function turnOff(): void {
  removeFirewall();
  stopProxy();
  untrustSystem();
}

export async function applyVault(user: AgentUser | null = agentUser(), dir = vaultDir()): Promise<{ status: VaultStatus; envChanged: boolean }> {
  if (user === null) return { status: vaultStatus(null, dir), envChanged: false };
  const enabled = readVault(dir).enabled;
  try {
    const env = enabled ? await turnOn(user, dir) : (turnOff(), {});
    memory.problem = null;
    const envChanged = setEnv(env);
    if (envChanged || enabled) exportForJobs(user, env);
    return { status: vaultStatus(user, dir), envChanged };
  } catch (err) {
    memory.problem = errMsg(err);
    log.warn({ err: memory.problem }, 'vault: could not apply the vault');
    return { status: vaultStatus(user, dir), envChanged: false };
  }
}

export function vaultStatus(user: AgentUser | null = agentUser(), dir = vaultDir()): VaultStatus {
  return {
    available: user !== null,
    enabled: user !== null && readVault(dir).enabled,
    running: proxyRunning(),
    version: PROXY_VERSION,
    problem: memory.problem ?? (readVault(dir).enabled ? proxyError() : null),
    browsers: memory.browsers,
  };
}
