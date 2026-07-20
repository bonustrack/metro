import { mkdirSync, writeFileSync } from 'node:fs';
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
  type AllowlistMap,
} from './agent-map.js';
import { accounts, agents, keys, type StationName } from './schema.js';

interface StationTarget {
  file: string;
  fileEnv: string;
  trainImport: string;
}

interface LoadedAccount {
  station: StationName;
  accountId: string;
  config: Record<string, unknown>;
}

interface LoadedAgent {
  name: string;
  accounts: LoadedAccount[];
  keys: { name: string; key: string }[];
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
    const keyRows = await db.select().from(keys).where(eq(keys.agentId, a.id));
    out.push({
      name: a.name,
      accounts: acctRows.map((r) => ({
        station: r.station,
        accountId: r.accountId,
        config: r.config as Record<string, unknown>,
      })),
      keys: keyRows.map((k) => ({ name: k.name, key: k.key })),
    });
  }
  return out;
}

function writeStations(list: LoadedAgent[]): string[] {
  mkdirSync(METRO_DIR, { recursive: true });
  mkdirSync(TRAINS_DIR, { recursive: true });

  const byStation = new Map<StationName, LoadedAccount[]>();
  const map: AgentMap = {};
  const allow: AllowlistMap = {};
  for (const agent of list)
    for (const a of agent.accounts) {
      const cur = byStation.get(a.station);
      if (cur) cur.push(a);
      else byStation.set(a.station, [a]);
      map[`${a.station}/${a.accountId}`] = agent.name;
      const al = a.config.allowlist;
      if (Array.isArray(al))
        allow[`${a.station}/${a.accountId}`] = al.filter(
          (x): x is string => typeof x === 'string',
        );
    }
  setAgentMap(map);
  setAllowlistMap(allow);

  const active: string[] = [];
  for (const [station, accts] of byStation) {
    const records = accts.map((a) => {
      const cfg = { ...a.config };
      delete cfg.allowlist;
      return { id: a.accountId, ...cfg };
    });
    writeSecure(accountFilePath(station), JSON.stringify(records, null, 2));
    writeFileSync(
      join(TRAINS_DIR, `${station}.ts`),
      `import '${STATION_TARGETS[station].trainImport}';\n`,
    );
    active.push(`${station}(${accts.length})`);
  }
  return active;
}

function applyAgentKey(list: LoadedAgent[]): void {
  if (list.length !== 1) return;
  const key = list[0]?.keys[0]?.key;
  if (key) process.env.METRO_MCP_HTTP_TOKEN = key;
}

export async function materializeFromDb(): Promise<void> {
  if (!databaseUrl())
    throw new Error('DATABASE_URL is not set — accounts load from Postgres');
  try {
    const list = await loadAgents();
    applyAgentKey(list);
    const active = writeStations(list);
    if (active.length === 0)
      throw new Error('no accounts found in the database');
    log.info({ stations: active }, 'db: materialized accounts from Postgres');
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  await materializeFromDb();
  process.exit(0);
}
