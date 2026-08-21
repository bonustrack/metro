import { and, eq, sql } from 'drizzle-orm';
import { newId } from './ids.js';
import { getDb } from './client.js';
import {
  AgentAdminError,
  isUniqueViolation,
  ownedAgentOrThrow,
  userIdForEmail,
} from './agent-admin.js';
import { stations, STATIONS, type StationName } from './schema.js';

const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_ATTEMPTS = 5;

export interface AccountRef {
  agentId: string;
  station: StationName;
  accountId: string;
}

export function isStationName(raw: unknown): raw is StationName {
  return (
    typeof raw === 'string' && (STATIONS as readonly string[]).includes(raw)
  );
}

export function parseAccountId(raw: string): string | null {
  return ACCOUNT_ID_RE.test(raw) ? raw : null;
}

async function assertTokenFree(
  station: StationName,
  token: string,
): Promise<void> {
  const rows = await getDb()
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.station, station),
        sql`${stations.config}->>'token' = ${token}`,
      ),
    );
  if (rows.length > 0)
    throw new AgentAdminError(
      'that bot token is already attached to a Metro account',
      409,
    );
}

export async function attachAccountToAgent(
  email: string,
  agentId: string,
  station: StationName,
  config: Record<string, unknown>,
): Promise<AccountRef> {
  const { agent } = await ownedAgentOrThrow(
    await userIdForEmail(email),
    agentId,
  );
  const token = config.token;
  if (typeof token === 'string') await assertTokenFree(station, token);
  const db = getDb();
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    const accountId = newId();
    try {
      await db
        .insert(stations)
        .values({ id: accountId, agentId: agent.id, station, config });
      return { agentId: agent.id, station, accountId };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AgentAdminError('could not allocate a free account id', 500);
}

export async function detachAccountFromAgent(
  email: string,
  agentId: string,
  station: StationName,
  accountId: string,
): Promise<AccountRef> {
  const { agent } = await ownedAgentOrThrow(
    await userIdForEmail(email),
    agentId,
  );
  const gone = await getDb()
    .delete(stations)
    .where(
      and(
        eq(stations.agentId, agent.id),
        eq(stations.station, station),
        eq(stations.id, accountId),
      ),
    )
    .returning({ id: stations.id });
  if (gone.length === 0)
    throw new AgentAdminError('no such account on this agent', 404);
  return { agentId: agent.id, station, accountId };
}
