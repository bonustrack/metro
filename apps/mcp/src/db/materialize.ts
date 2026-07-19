import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../daemon/log.js';
import { writeSecure } from '../daemon/secure-fs.js';
import { closeDb, databaseUrl } from './client.js';
import { accountsByStation, loadAgents, type LoadedAgent } from './load.js';
import { setAgentMap, type AgentMap } from './agent-map.js';
import type { StationName } from './schema.js';

interface StationTarget {
  file: string;
  fileEnv: string;
  trainImport: string;
}

const METRO_DIR = join(homedir(), '.metro');
const TRAINS_DIR =
  process.env.METRO_TRAINS_DIR ?? join(METRO_DIR, 'trains');

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

function buildAgentMap(agentList: LoadedAgent[]): AgentMap {
  const map: AgentMap = {};
  for (const agent of agentList)
    for (const acct of agent.accounts)
      map[`${acct.station}/${acct.accountId}`] = agent.name;
  return map;
}

function writeStations(agentList: LoadedAgent[]): string[] {
  const byStation = accountsByStation(agentList);
  mkdirSync(METRO_DIR, { recursive: true });
  mkdirSync(TRAINS_DIR, { recursive: true });
  const active: string[] = [];
  for (const [station, accts] of byStation) {
    if (accts.length === 0) continue;
    const records = accts.map((a) => ({ id: a.accountId, ...a.config }));
    writeSecure(accountFilePath(station), JSON.stringify(records, null, 2));
    const target = STATION_TARGETS[station];
    writeFileSync(
      join(TRAINS_DIR, `${station}.ts`),
      `import '${target.trainImport}';\n`,
    );
    active.push(`${station}(${accts.length})`);
  }
  return active;
}

export async function materializeFromDb(): Promise<void> {
  if (!databaseUrl())
    throw new Error(
      'DATABASE_URL is not set — accounts load from Postgres; set it (and run db:migrate + db:seed once)',
    );
  try {
    const agentList = await loadAgents();
    if (agentList.length === 0)
      throw new Error(
        'no agents found in the database (run db:seed to load your accounts)',
      );
    const active = writeStations(agentList);
    setAgentMap(buildAgentMap(agentList));
    log.info(
      { agents: agentList.map((a) => a.name), stations: active },
      'db: materialized agents from Postgres',
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  await materializeFromDb();
  process.exit(0);
}
