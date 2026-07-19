import { and, eq, or, type SQL } from 'drizzle-orm';
import { getDb } from './client.js';
import { accounts, agents, keys, type StationName } from './schema.js';

export interface LoadedAccount {
  agentId: string;
  agentName: string;
  station: StationName;
  accountId: string;
  config: Record<string, unknown>;
}

export interface LoadedKey {
  agentId: string;
  agentName: string;
  name: string;
  key: string;
}

export interface LoadedAgent {
  id: string;
  name: string;
  accounts: LoadedAccount[];
  keys: LoadedKey[];
}

function selectedAgent(): string | undefined {
  const v = process.env.METRO_AGENT?.trim();
  if (!v) return undefined;
  return v;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function agentSelector(sel: string): SQL | undefined {
  return UUID_RE.test(sel)
    ? or(eq(agents.name, sel), eq(agents.id, sel))
    : eq(agents.name, sel);
}

export async function loadAgents(): Promise<LoadedAgent[]> {
  const db = getDb();
  const sel = selectedAgent();
  const rows = sel
    ? await db.select().from(agents).where(agentSelector(sel))
    : await db.select().from(agents);

  const out: LoadedAgent[] = [];
  for (const a of rows) {
    const acctRows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.agentId, a.id), eq(accounts.enabled, true)));
    const keyRows = await db
      .select()
      .from(keys)
      .where(eq(keys.agentId, a.id));
    out.push({
      id: a.id,
      name: a.name,
      accounts: acctRows.map((r) => ({
        agentId: a.id,
        agentName: a.name,
        station: r.station,
        accountId: r.accountId,
        config: (r.config ?? {}) as Record<string, unknown>,
      })),
      keys: keyRows.map((k) => ({
        agentId: a.id,
        agentName: a.name,
        name: k.name,
        key: k.key,
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
