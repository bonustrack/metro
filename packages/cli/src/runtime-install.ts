import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { localStations } from './local.js';
import { STORE_ENTRY, daemonEntry, findBun, runtimeDir } from './runtime.js';

const MANIFEST_FILE = 'stations.json';
const MARKETPLACE = 'marketplace';
const METRO_SOURCES = join('node_modules', '@metro-labs');
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface RuntimeManifest {
  core: Record<string, string>;
  stations: Record<string, Record<string, string>>;
  patchedDependencies?: Record<string, string>;
}

export interface PreparedRuntime {
  dir: string;
  entry: string;
  trains: string;
  manifest: string;
}

export interface PrepareOptions {
  sources?: string;
  store?: string;
  agents?: string;
  bun?: string;
  log?: (line: string) => void;
}

export function runtimeStore(): string {
  const env = process.env.METRO_RUNTIME_STORE?.trim() ?? '';
  return env === '' ? join(homedir(), '.metro', 'runtime') : env;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const ranges = (raw: unknown): Record<string, string> =>
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
    ...(raw.patchedDependencies === undefined ? {} : { patchedDependencies: ranges(raw.patchedDependencies) }),
  };
}

export function dependenciesFor(manifest: RuntimeManifest, stations: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = { ...manifest.core };
  for (const station of new Set(stations)) Object.assign(out, manifest.stations[station] ?? {});
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function packageText(deps: Record<string, string>, patches: Record<string, string>): string {
  const patchedDependencies = Object.fromEntries(
    Object.entries(deps).flatMap(([name, version]) => {
      const key = `${name}@${version}`;
      const path = patches[key];
      return path === undefined ? [] : [[key, path]];
    }),
  );
  return `${JSON.stringify({
    name: 'metro-runtime',
    private: true,
    dependencies: deps,
    ...(Object.keys(patchedDependencies).length === 0 ? {} : { patchedDependencies }),
  }, null, 2)}\n`;
}

export function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function copyMarketplace(sources: string, store: string): boolean {
  const staged = join(sources, MARKETPLACE);
  if (!existsSync(staged)) return false;
  cpSync(staged, join(store, MARKETPLACE), { recursive: true });
  return true;
}

function syncSources(sources: string, store: string): boolean {
  const shim = join(sources, STORE_ENTRY);
  if (existsSync(shim)) copyFileSync(shim, join(store, STORE_ENTRY));
  const stamp = readOrNull(join(sources, 'runtime.json'));
  if (stamp !== null && readOrNull(join(store, 'runtime.json')) === stamp)
    return existsSync(join(store, MARKETPLACE)) ? false : copyMarketplace(sources, store);
  rmSync(join(store, METRO_SOURCES), { recursive: true, force: true });
  cpSync(join(sources, METRO_SOURCES), join(store, METRO_SOURCES), { recursive: true });
  rmSync(join(store, MARKETPLACE), { recursive: true, force: true });
  copyMarketplace(sources, store);
  if (stamp !== null) writeFileSync(join(store, 'runtime.json'), stamp);
  return true;
}

export function installDependencies(
  store: string,
  deps: Record<string, string>,
  bun: string,
  log: (line: string) => void,
  patches: Record<string, string> = {},
): boolean {
  const wanted = packageText(deps, patches);
  const marker = join(store, 'node_modules', '.metro-installed');
  if (existsSync(marker) && readOrNull(join(store, 'package.json')) === wanted) return false;
  rmSync(marker, { force: true });
  writeFileSync(join(store, 'package.json'), wanted);
  log(`Installing the channel SDKs this machine needs into ${store}`);
  const run = spawnSync(bun, ['install', '--no-summary', '--no-progress'], {
    cwd: store,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (run.error !== undefined || run.status !== 0)
    throw new Error(`bun install failed in ${store}: ${run.error?.message ?? `exit ${String(run.status)}`}`);
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return true;
}

export function prepareRuntime(opts: PrepareOptions = {}): PreparedRuntime {
  const sources = opts.sources ?? runtimeDir();
  const manifestPath = join(sources, MANIFEST_FILE);
  const manifest = readManifest(manifestPath);
  const store = opts.store ?? runtimeStore();
  const log =
    opts.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  mkdirSync(join(store, 'trains'), { recursive: true });
  syncSources(sources, store);
  for (const path of Object.values(manifest.patchedDependencies ?? {})) {
    mkdirSync(dirname(join(store, path)), { recursive: true });
    copyFileSync(join(sources, path), join(store, path));
  }
  installDependencies(
    store,
    dependenciesFor(manifest, localStations(opts.agents)),
    opts.bun ?? findBun(),
    log,
    manifest.patchedDependencies,
  );
  return { dir: store, entry: daemonEntry(store), trains: join(store, 'trains'), manifest: manifestPath };
}
