import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { log } from '../daemon/log.js';
import { writeSecure } from '../daemon/secure-fs.js';
import { closeDb, databaseUrl, getDb } from './client.js';
import { setAgentMap, type AgentMap } from './agent-map.js';
import { accounts, agents, type StationName } from './schema.js';

interface StationTarget {
  file: string;
  fileEnv: string;
  trainImport: string;
}

interface LoadedAccount {
  agent: string;
  station: StationName;
  accountId: string;
  config: Record<string, unknown>;
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
};

function accountFilePath(station: StationName): string {
  const target = STATION_TARGETS[station];
  return process.env[target.fileEnv] ?? join(METRO_DIR, target.file);
}

function agentFilter(): string | undefined {
  const v = process.env.METRO_AGENT?.trim();
  if (!v) return undefined;
  return v;
}

async function loadAccounts(): Promise<LoadedAccount[]> {
  const db = getDb();
  const only = agentFilter();
  const agentRows = only
    ? await db.select().from(agents).where(eq(agents.name, only))
    : await db.select().from(agents);

  const out: LoadedAccount[] = [];
  for (const a of agentRows) {
    const rows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.agent, a.name));
    for (const r of rows)
      out.push({
        agent: a.name,
        station: r.station,
        accountId: r.accountId,
        config: r.config as Record<string, unknown>,
      });
  }
  return out;
}

function writeStations(list: LoadedAccount[]): string[] {
  mkdirSync(METRO_DIR, { recursive: true });
  mkdirSync(TRAINS_DIR, { recursive: true });

  const byStation = new Map<StationName, LoadedAccount[]>();
  const map: AgentMap = {};
  for (const a of list) {
    const cur = byStation.get(a.station);
    if (cur) cur.push(a);
    else byStation.set(a.station, [a]);
    map[`${a.station}/${a.accountId}`] = a.agent;
  }
  setAgentMap(map);

  const active: string[] = [];
  for (const [station, accts] of byStation) {
    const records = accts.map((a) => ({ id: a.accountId, ...a.config }));
    writeSecure(accountFilePath(station), JSON.stringify(records, null, 2));
    writeFileSync(
      join(TRAINS_DIR, `${station}.ts`),
      `import '${STATION_TARGETS[station].trainImport}';\n`,
    );
    active.push(`${station}(${accts.length})`);
  }
  return active;
}

export async function materializeFromDb(): Promise<void> {
  if (!databaseUrl())
    throw new Error('DATABASE_URL is not set — accounts load from Postgres');
  try {
    const list = await loadAccounts();
    if (list.length === 0)
      throw new Error('no accounts found in the database');
    const active = writeStations(list);
    log.info({ stations: active }, 'db: materialized accounts from Postgres');
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  await materializeFromDb();
  process.exit(0);
}
