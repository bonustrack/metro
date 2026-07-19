import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { accounts, agents, type StationName } from './schema.js';

export interface LoadedAccount {
  agent: string;
  station: StationName;
  accountId: string;
  config: Record<string, unknown>;
}

export interface LoadedAgent {
  name: string;
  accounts: LoadedAccount[];
}

function selectedAgent(): string | undefined {
  const v = process.env.METRO_AGENT?.trim();
  if (!v) return undefined;
  return v;
}

export async function loadAgents(): Promise<LoadedAgent[]> {
  const db = getDb();
  const sel = selectedAgent();
  const rows = sel
    ? await db.select().from(agents).where(eq(agents.name, sel))
    : await db.select().from(agents);

  const out: LoadedAgent[] = [];
  for (const a of rows) {
    const acctRows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.agent, a.name));
    out.push({
      name: a.name,
      accounts: acctRows.map((r) => ({
        agent: a.name,
        station: r.station,
        accountId: r.accountId,
        config: r.config as Record<string, unknown>,
      })),
    });
  }
  return out;
}

export function accountsByStation(
  agentList: LoadedAgent[],
): Map<StationName, LoadedAccount[]> {
  const byStation = new Map<StationName, LoadedAccount[]>();
  for (const agent of agentList)
    for (const acct of agent.accounts) {
      const list = byStation.get(acct.station) ?? [];
      list.push(acct);
      byStation.set(acct.station, list);
    }
  return byStation;
}
