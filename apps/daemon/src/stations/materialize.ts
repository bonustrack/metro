import { setPolicies, type PolicyTarget, type ToolPolicy } from '../policy/policy.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { trainsDir } from '../boot/paths.js';
import {
  setAgentMap,
  setAllowlistMap,
  setApproversMap,
  setDisabledAccounts,
  type AgentMap,
  type AgentNameMap,
  type AllowlistMap,
} from '../agents/map.js';
import { setKeyMap } from '../agents/keys.js';
import { STATIONS, type StationName } from '@metro-labs/core/station-names';
import { stationByName } from './registry.js';

export interface LoadedAccount {
  station: StationName;
  id: string;
  allowlist: string[] | null;
  approvers?: string[];
  enabled?: boolean;
  policy?: ToolPolicy;
  config: Record<string, unknown>;
}

export interface LoadedAgent {
  id: string;
  name: string;
  accounts: LoadedAccount[];
  key: string | null;
}

const METRO_DIR = join(homedir(), '.metro');

const STATION_SET = new Set<string>(STATIONS);

export function accountFilePath(station: StationName): string {
  return process.env[`${station.toUpperCase().replace(/-/g, '_')}_ACCOUNTS_FILE`] ?? join(METRO_DIR, `${station}-accounts.json`);
}

const trainImport = (station: StationName): string | null =>
  stationByName(station)?.hasTrain === false ? null : `@metro-labs/${station}/train`;

export type StationSource = () => Promise<LoadedAgent[]>;

export const MOVABLE_STATIONS = new Set<StationName>(
  STATIONS.filter((s) => s !== 'webhook'),
);

function trainStubPath(station: StationName): string {
  return join(trainsDir(), `${station}.ts`);
}

function currentText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function writeIfChanged(path: string, content: string): boolean {
  if (currentText(path) === content) return false;
  writeFileSync(path, content);
  return true;
}

interface WrittenStations {
  active: Map<StationName, number>;
  changed: StationName[];
}

const channelPolicies = (list: LoadedAgent[]): [PolicyTarget, ToolPolicy][] =>
  list.flatMap((agent) =>
    agent.accounts.flatMap((a): [PolicyTarget, ToolPolicy][] =>
      a.policy === undefined ? [] : [[{ kind: 'channel', station: a.station, account: a.id }, a.policy]],
    ),
  );

const approversOf = (list: LoadedAgent[]): Record<string, string[]> =>
  Object.fromEntries(
    list.flatMap((agent) => agent.accounts.flatMap((a) => (a.approvers === undefined ? [] : [[`${a.station}/${a.id}`, a.approvers]]))),
  );

function writeStations(list: LoadedAgent[]): WrittenStations {
  mkdirSync(METRO_DIR, { recursive: true });
  mkdirSync(trainsDir(), { recursive: true });

  const byStation = new Map<StationName, LoadedAccount[]>();
  const map: AgentMap = {};
  const names: AgentNameMap = {};
  const allow: AllowlistMap = {};
  const disabled = new Set<string>();
  for (const agent of list) {
    names[agent.id] = agent.name;
    for (const a of agent.accounts) {
      if (!STATION_SET.has(a.station)) {
        log.error(
          { station: a.station, id: a.id },
          'unknown station — this metro is older or newer than the row; skipping it',
        );
        continue;
      }
      map[`${a.station}/${a.id}`] = agent.id;
      if (a.allowlist) allow[`${a.station}/${a.id}`] = a.allowlist;
      if (a.enabled === false) disabled.add(`${a.station}/${a.id}`);
      const cur = byStation.get(a.station);
      if (cur) cur.push(a);
      else byStation.set(a.station, [a]);
    }
  }
  setAgentMap(map, names);
  setAllowlistMap(allow);
  setApproversMap(approversOf(list));
  setDisabledAccounts(disabled);
  setPolicies('channel', channelPolicies(list));

  const active = new Map<StationName, number>();
  const changed: StationName[] = [];
  for (const [station, accts] of byStation) {
    const records = accts.map((a) => ({ id: a.id, ...a.config }));
    const path = accountFilePath(station);
    const content = JSON.stringify(records, null, 2);
    if (currentText(path) !== content) {
      writeSecure(path, content);
      changed.push(station);
    }
    const train = trainImport(station);
    if (train !== null)
      writeIfChanged(trainStubPath(station), `import '${train}';\n`);
    active.set(station, accts.length);
  }
  return { active, changed };
}

const BLANKED = '[]\n';

function pruneStations(present: Map<StationName, number>): StationName[] {
  const removed: StationName[] = [];
  for (const station of STATIONS) {
    if (present.has(station)) continue;
    const hasTrain = trainImport(station) !== null;
    const stub = trainStubPath(station);
    const stubGone = !hasTrain || !existsSync(stub);
    const file = currentText(accountFilePath(station));
    const fileInert = file === null || file === BLANKED;
    if (stubGone && fileInert) continue;
    if (!fileInert) writeSecure(accountFilePath(station), BLANKED);
    if (hasTrain) rmSync(stub, { force: true });
    removed.push(station);
  }
  return removed;
}

const stationLabels = (m: Map<StationName, number>): string[] =>
  [...m].map(([station, n]) => `${station}(${n})`);

function applyKeyMap(list: LoadedAgent[]): void {
  setKeyMap(
    list.flatMap((agent) =>
      agent.key === null ? [] : [{ key: agent.key, agentId: agent.id }],
    ),
  );
}

async function loadAndWrite(
  source: StationSource,
): Promise<WrittenStations & { agents: number }> {
  const list = await source();
  applyKeyMap(list);
  return { ...writeStations(list), agents: list.length };
}

export async function materializeFrom(source: StationSource): Promise<void> {
  const { active, agents: found } = await loadAndWrite(source);
  const removed = pruneStations(active);
  log.info(
    { stations: stationLabels(active), agents: found, removed },
    'materialized station accounts',
  );
}

export interface ReloadedStations {
  active: StationName[];
  removed: StationName[];
  changed: StationName[];
}

export async function reloadFrom(
  source: StationSource,
): Promise<ReloadedStations> {
  const { active, changed } = await loadAndWrite(source);
  const removed = pruneStations(active);
  if (removed.length > 0 || changed.length > 0)
    log.info(
      { stations: stationLabels(active), removed, changed },
      'reloaded station accounts',
    );
  return { active: [...active.keys()], removed, changed };
}
