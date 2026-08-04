import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { log } from '../daemon/log.js';
import { writeSecure } from '../daemon/secure-fs.js';
import { closeDb, databaseUrl, getDb } from './client.js';
import {
  setAgentMap,
  setAllowlistMap,
  type AgentMap,
  type AgentNameMap,
  type AllowlistMap,
} from './agent-map.js';
import { setKeyMap } from './key-map.js';
import { accounts, agents, type StationName } from './schema.js';

interface StationTarget {
  file: string;
  fileEnv: string;
  trainImport: string;
}

interface LoadedAccount {
  station: StationName;
  accountId: string;
  allowlist: string[] | null;
  config: Record<string, unknown>;
}

interface LoadedAgent {
  id: number;
  name: string;
  accounts: LoadedAccount[];
  key: string | null;
}

const METRO_DIR = join(homedir(), '.metro');
const TRAINS_DIR = process.env.METRO_TRAINS_DIR ?? join(METRO_DIR, 'trains');

const STATION_TARGETS: Record<StationName, StationTarget> = {
  xmtp: {
    file: 'xmtp-accounts.json',
    fileEnv: 'XMTP_ACCOUNTS_FILE',
    trainImport: '@metro-labs/xmtp/train',
  },
  telegram: {
    file: 'telegram-accounts.json',
    fileEnv: 'TELEGRAM_ACCOUNTS_FILE',
    trainImport: '@metro-labs/telegram/train',
  },
  'telegram-user': {
    file: 'telegram-user-accounts.json',
    fileEnv: 'TELEGRAM_USER_ACCOUNTS_FILE',
    trainImport: '@metro-labs/telegram-user/train',
  },
  discord: {
    file: 'discord-accounts.json',
    fileEnv: 'DISCORD_ACCOUNTS_FILE',
    trainImport: '@metro-labs/discord/train',
  },
  whatsapp: {
    file: 'whatsapp-accounts.json',
    fileEnv: 'WHATSAPP_ACCOUNTS_FILE',
    trainImport: '@metro-labs/whatsapp/train',
  },
  line: {
    file: 'line-accounts.json',
    fileEnv: 'LINE_ACCOUNTS_FILE',
    trainImport: '@metro-labs/line/train',
  },
};

function accountFilePath(station: StationName): string {
  const target = STATION_TARGETS[station];
  return process.env[target.fileEnv] ?? join(METRO_DIR, target.file);
}

function agentFilter(): number | undefined {
  const v = process.env.METRO_AGENT?.trim();
  if (!v) return undefined;
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0)
    throw new Error(`METRO_AGENT must be an agent id (positive integer), got '${v}'`);
  return id;
}

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
      .from(accounts)
      .where(eq(accounts.agentId, a.id));
    out.push({
      id: a.id,
      name: a.name,
      accounts: acctRows.map((r) => ({
        station: r.station,
        accountId: r.accountId,
        allowlist: r.allowlist,
        config: r.config as Record<string, unknown>,
      })),
      key: a.key,
    });
  }
  return out;
}

function trainStubPath(station: StationName): string {
  return join(TRAINS_DIR, `${station}.ts`);
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

function writeStations(list: LoadedAgent[]): Map<StationName, number> {
  mkdirSync(METRO_DIR, { recursive: true });
  mkdirSync(TRAINS_DIR, { recursive: true });

  const byStation = new Map<StationName, LoadedAccount[]>();
  const map: AgentMap = {};
  const names: AgentNameMap = {};
  const allow: AllowlistMap = {};
  for (const agent of list) {
    names[agent.id] = agent.name;
    for (const a of agent.accounts) {
      const cur = byStation.get(a.station);
      if (cur) cur.push(a);
      else byStation.set(a.station, [a]);
      map[`${a.station}/${a.accountId}`] = agent.id;
      if (a.allowlist) allow[`${a.station}/${a.accountId}`] = a.allowlist;
    }
  }
  setAgentMap(map, names);
  setAllowlistMap(allow);

  const active = new Map<StationName, number>();
  for (const [station, accts] of byStation) {
    const records = accts.map((a) => ({ id: a.accountId, ...a.config }));
    writeSecure(accountFilePath(station), JSON.stringify(records, null, 2));
    writeIfChanged(
      trainStubPath(station),
      `import '${STATION_TARGETS[station].trainImport}';\n`,
    );
    active.set(station, accts.length);
  }
  return active;
}

function pruneStations(present: Map<StationName, number>): StationName[] {
  const removed: StationName[] = [];
  for (const station of Object.keys(STATION_TARGETS) as StationName[]) {
    if (present.has(station)) continue;
    const stub = trainStubPath(station);
    if (!existsSync(stub) && !existsSync(accountFilePath(station))) continue;
    writeSecure(accountFilePath(station), '[]\n');
    rmSync(stub, { force: true });
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

async function loadAndWrite(): Promise<Map<StationName, number>> {
  const list = await loadAgents();
  applyKeyMap(list);
  return writeStations(list);
}

export async function materializeFromDb(): Promise<void> {
  if (!databaseUrl())
    throw new Error('DATABASE_URL is not set — accounts load from Postgres');
  try {
    const active = await loadAndWrite();
    if (active.size === 0) throw new Error('no accounts found in the database');
    log.info(
      { stations: stationLabels(active) },
      'db: materialized accounts from Postgres',
    );
  } finally {
    await closeDb();
  }
}

export interface ReloadedStations {
  active: StationName[];
  removed: StationName[];
}

export async function reloadAccountsFromDb(): Promise<ReloadedStations> {
  if (!databaseUrl())
    throw new Error('DATABASE_URL is not set — accounts load from Postgres');
  const active = await loadAndWrite();
  const removed = pruneStations(active);
  log.info(
    { stations: stationLabels(active), removed },
    'db: reloaded accounts from Postgres',
  );
  return { active: [...active.keys()], removed };
}

if (import.meta.main) {
  await materializeFromDb();
  process.exit(0);
}
