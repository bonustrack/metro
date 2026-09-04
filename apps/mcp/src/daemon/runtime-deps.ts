import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { isRecord } from './is-record.js';
import type { StationName } from '../db/stations.js';
import { knownAccounts } from '../db/agent-map.js';

const INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface RuntimeManifest {
  core: Record<string, string>;
  stations: Record<string, Record<string, string>>;
}

export interface RuntimeStore {
  dir: string;
  manifest: RuntimeManifest;
}

const ranges = (raw: unknown): Record<string, string> =>
  isRecord(raw)
    ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};

export function readManifest(path: string): RuntimeManifest {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error(`${path} is not a runtime manifest`);
  const stations = isRecord(raw.stations) ? raw.stations : {};
  return {
    core: ranges(raw.core),
    stations: Object.fromEntries(Object.entries(stations).map(([name, deps]) => [name, ranges(deps)])),
  };
}

export function runtimeStore(): RuntimeStore | null {
  const dir = process.env.METRO_RUNTIME_STORE?.trim() ?? '';
  const manifest = process.env.METRO_RUNTIME_MANIFEST?.trim() ?? '';
  if (dir === '' || manifest === '') return null;
  return { dir, manifest: readManifest(manifest) };
}

export function dependenciesFor(manifest: RuntimeManifest, stations: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = { ...manifest.core };
  for (const station of new Set(stations)) Object.assign(out, manifest.stations[station] ?? {});
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const packageText = (deps: Record<string, string>): string =>
  `${JSON.stringify({ name: 'metro-runtime', private: true, dependencies: deps }, null, 2)}\n`;

function current(dir: string): string | null {
  try {
    return readFileSync(join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }
}

export function installRuntime(store: RuntimeStore, stations: Iterable<string>): boolean {
  const wanted = packageText(dependenciesFor(store.manifest, stations));
  const installed = existsSync(join(store.dir, 'node_modules', '.metro-installed'));
  if (installed && current(store.dir) === wanted) return false;
  mkdirSync(store.dir, { recursive: true });
  writeFileSync(join(store.dir, 'package.json'), wanted);
  log.info({ dir: store.dir }, 'runtime: installing the channel SDKs this machine needs');
  const run = spawnSync('bun', ['install', '--no-summary', '--no-progress'], {
    cwd: store.dir,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (run.error !== undefined || run.status !== 0)
    throw new Error(`bun install failed in ${store.dir}: ${run.error?.message ?? `exit ${String(run.status)}`}`);
  writeFileSync(join(store.dir, 'node_modules', '.metro-installed'), `${new Date().toISOString()}\n`);
  return true;
}

export function ensureStationDeps(station: StationName): void {
  const store = runtimeStore();
  if (store === null) return;
  installRuntime(store, [...knownAccounts().map((a) => a.station), station]);
}
