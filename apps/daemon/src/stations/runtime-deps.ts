import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import type { StationName } from '@metro-labs/core/station-names';
import { knownAccounts } from '../agents/map.js';

const INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface RuntimeManifest {
  core: Record<string, string>;
  stations: Record<string, Record<string, string>>;
  patchedDependencies?: Record<string, string>;
}

export interface RuntimeStore {
  dir: string;
  sources: string;
  manifest: RuntimeManifest;
}

const ranges = (raw: unknown): Record<string, string> =>
  isRecord(raw)
    ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};

function patchesOf(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) throw new Error('Invalid runtime patch map');
  return Object.fromEntries(Object.entries(raw).map(([name, path]) => {
    if (typeof path !== 'string' || !/^patches\/[a-f0-9]{64}\.patch$/.test(path))
      throw new Error(`Invalid runtime patch path for ${name}`);
    return [name, path];
  }));
}

export function readManifest(path: string): RuntimeManifest {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error(`${path} is not a runtime manifest`);
  const stations = isRecord(raw.stations) ? raw.stations : {};
  return {
    core: ranges(raw.core),
    stations: Object.fromEntries(Object.entries(stations).map(([name, deps]) => [name, ranges(deps)])),
    ...(raw.patchedDependencies === undefined ? {} : { patchedDependencies: patchesOf(raw.patchedDependencies) }),
  };
}

export function runtimeStore(): RuntimeStore | null {
  const dir = process.env.METRO_RUNTIME_STORE?.trim() ?? '';
  const manifest = process.env.METRO_RUNTIME_MANIFEST?.trim() ?? '';
  if (dir === '' || manifest === '') return null;
  return { dir, sources: dirname(manifest), manifest: readManifest(manifest) };
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

function current(dir: string): string | null {
  try {
    return readFileSync(join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }
}

function copyPatches(store: RuntimeStore): void {
  const paths = Object.values(patchesOf(store.manifest.patchedDependencies ?? {}));
  if (paths.length === 0) return;
  const destination = join(store.dir, 'patches');
  mkdirSync(destination, { recursive: true });
  if (!lstatSync(join(store.sources, 'patches')).isDirectory() || !lstatSync(destination).isDirectory())
    throw new Error('Invalid runtime patch directory');
  for (const path of new Set(paths)) {
    const source = join(store.sources, path);
    const target = join(store.dir, path);
    if (!lstatSync(source).isFile() || lstatSync(target, { throwIfNoEntry: false })?.isFile() === false)
      throw new Error(`Invalid runtime patch file: ${path}`);
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
    if (path !== `patches/${hash}.patch`) throw new Error(`Invalid runtime patch contents: ${path}`);
    copyFileSync(source, target);
  }
}

export function installRuntime(store: RuntimeStore, stations: Iterable<string>): boolean {
  const wanted = packageText(dependenciesFor(store.manifest, stations), store.manifest.patchedDependencies ?? {});
  const marker = join(store.dir, 'node_modules', '.metro-installed');
  try {
    copyPatches(store);
  } catch (err) {
    rmSync(marker, { force: true });
    throw err;
  }
  if (existsSync(marker) && current(store.dir) === wanted) return false;
  rmSync(marker, { force: true });
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
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return true;
}

export function ensureStationDeps(station?: StationName): void {
  const store = runtimeStore();
  if (store === null) return;
  const stations = knownAccounts().map((a) => a.station);
  if (station !== undefined) stations.push(station);
  installRuntime(store, stations);
}
