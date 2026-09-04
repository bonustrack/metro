import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { ID_RE } from './ids.js';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { log } from '../daemon/log.js';
import { writeSecure } from '../daemon/secure-fs.js';
import { isLocalMode, trainsDir } from '../daemon/paths.js';
import { closeDb, databaseUrl, getDb } from './client.js';
import {
  setAgentMap,
  setAllowlistMap,
  type AgentMap,
  type AgentNameMap,
  type AllowlistMap,
} from './agent-map.js';
import { setKeyMap } from './key-map.js';
import {
  agentConnectors,
  agents,
  connectors,
  stations,
  STATIONS,
  type StationName,
} from './schema.js';

interface StationTarget {
  file: string;
  fileEnv: string;
  trainImport: string | null;
}

export interface LoadedAccount {
  station: StationName;
  id: string;
  allowlist: string[] | null;
  config: Record<string, unknown>;
}

export interface LoadedConnector {
  id: string;
  name: string;
  url: string;
  transport: 'http';
  config: Record<string, unknown>;
}

export interface LoadedAgent {
  id: string;
  name: string;
  accounts: LoadedAccount[];
  key: string | null;
  connectors?: LoadedConnector[];
}

const METRO_DIR = join(homedir(), '.metro');

const STATION_TARGETS: Record<StationName, StationTarget> = {
  xmtp: {
    file: 'xmtp-accounts.json',
    fileEnv: 'XMTP_ACCOUNTS_FILE',
    trainImport: '@metro-labs/xmtp/train',
  },
  'telegram-bot': {
    file: 'telegram-bot-accounts.json',
    fileEnv: 'TELEGRAM_BOT_ACCOUNTS_FILE',
    trainImport: '@metro-labs/telegram-bot/train',
  },
  'telegram': {
    file: 'telegram-accounts.json',
    fileEnv: 'TELEGRAM_ACCOUNTS_FILE',
    trainImport: '@metro-labs/telegram/train',
  },
  'discord-bot': {
    file: 'discord-bot-accounts.json',
    fileEnv: 'DISCORD_BOT_ACCOUNTS_FILE',
    trainImport: '@metro-labs/discord-bot/train',
  },
  whatsapp: {
    file: 'whatsapp-accounts.json',
    fileEnv: 'WHATSAPP_ACCOUNTS_FILE',
    trainImport: '@metro-labs/whatsapp/train',
  },
  webhook: {
    file: 'webhook-accounts.json',
    fileEnv: 'WEBHOOK_ACCOUNTS_FILE',
    trainImport: null,
  },
};

function accountFilePath(station: StationName): string {
  const target = STATION_TARGETS[station];
  return process.env[target.fileEnv] ?? join(METRO_DIR, target.file);
}

function agentFilter(): string | undefined {
  const v = process.env.METRO_AGENT?.trim();
  if (!v) return undefined;
  if (!ID_RE.test(v))
    throw new Error(`METRO_AGENT must be an 11-character agent id, got '${v}'`);
  return v;
}

export type StationSource = () => Promise<LoadedAgent[]>;

export const MOVABLE_STATIONS = new Set<StationName>(
  STATIONS.filter((s) => s !== 'webhook'),
);

export function unmovableStations(list: LoadedAccount[]): StationName[] {
  return [
    ...new Set(
      list
        .map((a) => a.station)
        .filter((station) => !MOVABLE_STATIONS.has(station)),
    ),
  ];
}

export async function loadAllStationsFor(
  agentId: string,
): Promise<LoadedAccount[]> {
  const rows = await getDb()
    .select()
    .from(stations)
    .where(eq(stations.agentId, agentId));
  return rows.map((r) => ({
    station: r.station,
    id: r.id,
    allowlist: r.allowlist,
    config: r.config as Record<string, unknown>,
  }));
}

export async function loadAgentForRuntime(
  agentId: string,
): Promise<LoadedAgent> {
  const db = getDb();
  const rows = await db.select().from(agents).where(eq(agents.id, agentId));
  const a = rows[0];
  if (a === undefined) throw new Error(`no such agent '${agentId}'`);
  const acctRows = await db
    .select()
    .from(stations)
    .where(eq(stations.agentId, a.id));
  const held = await db
    .select({ id: connectors.id, name: connectors.name, url: connectors.url, config: connectors.config })
    .from(agentConnectors)
    .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
    .where(eq(agentConnectors.agentId, a.id));
  return {
    id: a.id,
    name: a.name,
    key: a.key,
    connectors: held.map((c) => ({
      id: c.id,
      name: c.name,
      url: c.url,
      transport: 'http' as const,
      config: c.config as Record<string, unknown>,
    })),
    accounts: acctRows
      .filter((r) => MOVABLE_STATIONS.has(r.station))
      .map((r) => ({
        station: r.station,
        id: r.id,
        allowlist: r.allowlist,
        config: r.config as Record<string, unknown>,
      })),
  };
}

const pgSource: StationSource = () => loadAgents();

async function loadAgents(): Promise<LoadedAgent[]> {
  const db = getDb();
  const only = agentFilter();
  const agentRows =
    only !== undefined
      ? await db.select().from(agents).where(eq(agents.id, only))
      : await db.select().from(agents);
  if (only !== undefined && agentRows.length === 0)
    throw new Error(`METRO_AGENT=${only} does not match any agent`);

  const out: LoadedAgent[] = [];
  for (const a of agentRows) {
    const acctRows = await db
      .select()
      .from(stations)
      .where(eq(stations.agentId, a.id));
    out.push({
      id: a.id,
      name: a.name,
      accounts: acctRows.map((r) => ({
        station: r.station,
        id: r.id,
        allowlist: r.allowlist,
        config: r.config as Record<string, unknown>,
      })),
      key: a.runtimeId === null ? a.key : null,
    });
  }
  return out;
}

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

const isLocalRuntime = (): boolean =>
  (process.env.METRO_RUN_TOKEN?.trim() ?? '') !== '';

export const stationRunsHere = (station: StationName): boolean =>
  isLocalRuntime() || isLocalMode() || !MOVABLE_STATIONS.has(station);

interface WrittenStations {
  active: Map<StationName, number>;
  changed: StationName[];
}

function writeStations(list: LoadedAgent[]): WrittenStations {
  mkdirSync(METRO_DIR, { recursive: true });
  mkdirSync(trainsDir(), { recursive: true });

  const byStation = new Map<StationName, LoadedAccount[]>();
  const map: AgentMap = {};
  const names: AgentNameMap = {};
  const allow: AllowlistMap = {};
  for (const agent of list) {
    names[agent.id] = agent.name;
    for (const a of agent.accounts) {
      if (!(a.station in STATION_TARGETS)) {
        log.error(
          { station: a.station, id: a.id },
          'unknown station — this metro is older or newer than the row; skipping it',
        );
        continue;
      }
      map[`${a.station}/${a.id}`] = agent.id;
      if (a.allowlist) allow[`${a.station}/${a.id}`] = a.allowlist;
      if (stationRunsHere(a.station)) {
        const cur = byStation.get(a.station);
        if (cur) cur.push(a);
        else byStation.set(a.station, [a]);
      }
    }
  }
  setAgentMap(map, names);
  setAllowlistMap(allow);

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
    const { trainImport } = STATION_TARGETS[station];
    if (trainImport !== null)
      writeIfChanged(trainStubPath(station), `import '${trainImport}';\n`);
    active.set(station, accts.length);
  }
  return { active, changed };
}

const BLANKED = '[]\n';

function pruneStations(present: Map<StationName, number>): StationName[] {
  const removed: StationName[] = [];
  for (const station of Object.keys(STATION_TARGETS) as StationName[]) {
    if (present.has(station)) continue;
    const hasTrain = STATION_TARGETS[station].trainImport !== null;
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
  lastKey = list.find((a) => a.key !== null)?.key ?? null;
  setKeyMap(
    list.flatMap((agent) =>
      agent.key === null ? [] : [{ key: agent.key, agentId: agent.id }],
    ),
  );
}

let lastKey: string | null = null;

export function localAgentKey(): string | null {
  return lastKey;
}

async function loadAndWrite(
  source: StationSource,
): Promise<WrittenStations & { agents: number }> {
  const list = await source();
  applyKeyMap(list);
  return { ...writeStations(list), agents: list.length };
}

export interface MaterializeOptions {
  allowEmpty?: boolean;
}

export async function materializeFrom(
  source: StationSource,
  opts: MaterializeOptions = {},
): Promise<void> {
  const { active, agents: found } = await loadAndWrite(source);

  if (found === 0 && opts.allowEmpty !== true)
    throw new Error('no agents found — nothing to materialize');
  const removed = pruneStations(active);
  log.info(
    { stations: stationLabels(active), agents: found, removed },
    'materialized station accounts',
  );
}

export async function materializeFromDb(): Promise<void> {
  if (!databaseUrl())
    throw new Error('DATABASE_URL is not set — accounts load from Postgres');
  try {
    await materializeFrom(pgSource);
  } finally {
    await closeDb();
  }
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

export async function reloadAccountsFromDb(): Promise<ReloadedStations> {
  if (!databaseUrl())
    throw new Error('DATABASE_URL is not set — accounts load from Postgres');
  return reloadFrom(pgSource);
}

if (import.meta.main) {
  await materializeFromDb();
  process.exit(0);
}
