import { existsSync, rmSync } from 'node:fs';
import { stringOf } from '@metro-labs/http/api-http';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { newId } from '@metro-labs/core/ids';
import { ensureSecureDir, readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { stateFile, valueFile, valuesDir, vaultDir } from './paths.js';

export interface VaultSecret {
  id: string;
  name: string;
  env: string;
  hosts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VaultState {
  version: 1;
  enabled: boolean;
  secrets: VaultSecret[];
}

export interface SecretInput {
  name?: unknown;
  env?: unknown;
  hosts?: unknown;
  value?: unknown;
}

const ENV_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const RESERVED_ENV = new Set(['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TERM', 'LOGNAME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY']);
const MAX_SECRETS = 100;
const MAX_HOSTS = 20;
const MAX_VALUE = 16 * 1024;

function secretOf(raw: unknown): VaultSecret | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ENV_RE.test(stringOf(raw.env))) return null;
  const hosts = Array.isArray(raw.hosts) ? raw.hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h)) : [];
  return { id: raw.id, name: stringOf(raw.name) || stringOf(raw.env), env: stringOf(raw.env), hosts, createdAt: stringOf(raw.createdAt), updatedAt: stringOf(raw.updatedAt) };
}

export function readVault(dir = vaultDir()): VaultState {
  const raw = readJson<unknown>(stateFile(dir), null);
  if (!isRecord(raw)) return { version: 1, enabled: false, secrets: [] };
  const secrets = Array.isArray(raw.secrets) ? raw.secrets.map(secretOf).filter((s): s is VaultSecret => s !== null) : [];
  return { version: 1, enabled: raw.enabled === true, secrets };
}

export function writeVault(state: VaultState, dir = vaultDir()): void {
  ensureSecureDir(dir);
  writeSecure(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`);
}

export function normalizeName(raw: unknown): string {
  const name = stringOf(raw).trim();
  if (name === '' || name.length > 80) throw new ApiError('a name of 1 to 80 characters is required', 400);
  return name;
}

export function normalizeEnv(raw: unknown): string {
  const env = stringOf(raw).trim();
  if (!ENV_RE.test(env) || RESERVED_ENV.has(env))
    throw new ApiError('the variable name must be capital letters, digits and _, 3 to 64 long, like OPENAI_API_KEY', 400);
  return env;
}

export function normalizeHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError('hosts must be a list of websites, like api.openai.com', 400);
  const hosts = [...new Set(raw.map((h) => stringOf(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((h) => h !== ''))];
  if (hosts.length === 0 || hosts.length > MAX_HOSTS) throw new ApiError(`a secret needs 1 to ${String(MAX_HOSTS)} websites`, 400);
  const bad = hosts.find((h) => !HOST_RE.test(h));
  if (bad !== undefined) throw new ApiError(`'${bad}' is not a website name; write it as api.example.com or *.example.com`, 400);
  return hosts;
}

export function normalizeValue(raw: unknown): string {
  const value = stringOf(raw).trim();
  if (value === '' || value.length > MAX_VALUE) throw new ApiError('a value of 1 to 16384 characters is required', 400);
  return value;
}

function saveValue(id: string, value: string, dir: string): void {
  ensureSecureDir(valuesDir(dir));
  writeSecure(valueFile(id, dir), value);
}

export function addSecret(input: SecretInput, dir = vaultDir(), now = new Date()): VaultSecret {
  const state = readVault(dir);
  if (state.secrets.length >= MAX_SECRETS) throw new ApiError(`at most ${String(MAX_SECRETS)} secrets`, 400);
  const env = normalizeEnv(input.env);
  if (state.secrets.some((s) => s.env === env)) throw new ApiError(`${env} is already a secret`, 409);
  const at = now.toISOString();
  const secret: VaultSecret = { id: newId(), name: normalizeName(input.name ?? env), env, hosts: normalizeHosts(input.hosts), createdAt: at, updatedAt: at };
  saveValue(secret.id, normalizeValue(input.value), dir);
  writeVault({ ...state, secrets: [...state.secrets, secret] }, dir);
  return secret;
}

export function updateSecret(id: string, input: SecretInput, dir = vaultDir(), now = new Date()): VaultSecret {
  const state = readVault(dir);
  const found = state.secrets.find((s) => s.id === id);
  if (found === undefined) throw new ApiError('no such secret', 404);
  const next: VaultSecret = {
    ...found,
    ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
    ...(input.hosts === undefined ? {} : { hosts: normalizeHosts(input.hosts) }),
    updatedAt: now.toISOString(),
  };
  if (input.value !== undefined) saveValue(id, normalizeValue(input.value), dir);
  writeVault({ ...state, secrets: state.secrets.map((s) => (s.id === id ? next : s)) }, dir);
  return next;
}

export function removeSecret(id: string, dir = vaultDir()): void {
  const state = readVault(dir);
  if (!state.secrets.some((s) => s.id === id)) throw new ApiError('no such secret', 404);
  writeVault({ ...state, secrets: state.secrets.filter((s) => s.id !== id) }, dir);
  rmSync(valueFile(id, dir), { force: true });
}

export function setVaultEnabled(enabled: boolean, dir = vaultDir()): VaultState {
  const next = { ...readVault(dir), enabled };
  writeVault(next, dir);
  return next;
}

export const hasValue = (id: string, dir = vaultDir()): boolean => existsSync(valueFile(id, dir));
