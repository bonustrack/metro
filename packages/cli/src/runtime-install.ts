import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localStations } from './local.js';
import { SERVER_ENTRY, findBun, runtimeDir } from './runtime.js';

export const MANIFEST_FILE = 'stations.json';
const METRO_SOURCES = join('node_modules', '@metro-labs');
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface RuntimeManifest {
  core: Record<string, string>;
  stations: Record<string, Record<string, string>>;
}

export interface PreparedRuntime {
  dir: string;
  entry: string;
  trains: string;
  manifest: string | null;
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

export function dependenciesFor(manifest: RuntimeManifest, stations: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = { ...manifest.core };
  for (const station of new Set(stations)) Object.assign(out, manifest.stations[station] ?? {});
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const packageText = (deps: Record<string, string>): string =>
  `${JSON.stringify({ name: 'metro-runtime', private: true, dependencies: deps }, null, 2)}\n`;

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function syncSources(sources: string, store: string): boolean {
  const stamp = readOrNull(join(sources, 'runtime.json'));
  if (stamp !== null && readOrNull(join(store, 'runtime.json')) === stamp) return false;
  rmSync(join(store, METRO_SOURCES), { recursive: true, force: true });
  cpSync(join(sources, METRO_SOURCES), join(store, METRO_SOURCES), { recursive: true });
  if (stamp !== null) writeFileSync(join(store, 'runtime.json'), stamp);
  return true;
}

export function installDependencies(
  store: string,
  deps: Record<string, string>,
  bun: string,
  log: (line: string) => void,
): boolean {
  const wanted = packageText(deps);
  const marker = join(store, 'node_modules', '.metro-installed');
  if (existsSync(marker) && readOrNull(join(store, 'package.json')) === wanted) return false;
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
  if (!existsSync(manifestPath))
    return { dir: sources, entry: join(sources, SERVER_ENTRY), trains: join(sources, 'trains'), manifest: null };
  const store = opts.store ?? runtimeStore();
  const log =
    opts.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  mkdirSync(join(store, 'trains'), { recursive: true });
  syncSources(sources, store);
  installDependencies(
    store,
    dependenciesFor(readManifest(manifestPath), localStations(opts.agents)),
    opts.bun ?? findBun(),
    log,
  );
  return { dir: store, entry: join(store, SERVER_ENTRY), trains: join(store, 'trains'), manifest: manifestPath };
}
