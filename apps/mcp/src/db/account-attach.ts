import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import {
  AgentAdminError,
  isUniqueViolation,
  ownedAgentOrThrow,
  userIdForEmail,
} from './agent-admin.js';
import { accounts, STATIONS, type StationName } from './schema.js';

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_ATTEMPTS = 5;

export interface AccountRef {
  agentId: number;
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

function newAccountId(agentId: number): string {
  return `a${agentId}-${randomBytes(4).toString('hex')}`;
}

async function assertTokenFree(
  station: StationName,
  token: string,
): Promise<void> {
  const rows = await getDb()
    .select({ accountId: accounts.accountId })
    .from(accounts)
    .where(
      and(
        eq(accounts.station, station),
        sql`${accounts.config}->>'token' = ${token}`,
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
  granted: string[],
  agentId: number,
  station: StationName,
  config: Record<string, unknown>,
): Promise<AccountRef> {
  const { agent } = await ownedAgentOrThrow(
    await userIdForEmail(email),
    granted,
    agentId,
    'changed',
  );
  const token = config.token;
  if (typeof token === 'string') await assertTokenFree(station, token);
  const db = getDb();
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    const accountId = newAccountId(agent.id);
    try {
      await db
        .insert(accounts)
        .values({ agentId: agent.id, station, accountId, config });
      return { agentId: agent.id, station, accountId };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AgentAdminError('could not allocate a free account id', 500);
}

export async function detachAccountFromAgent(
  email: string,
  granted: string[],
  agentId: number,
  station: StationName,
  accountId: string,
): Promise<AccountRef> {
  const { agent } = await ownedAgentOrThrow(
    await userIdForEmail(email),
    granted,
    agentId,
    'changed',
  );
  const gone = await getDb()
    .delete(accounts)
    .where(
      and(
        eq(accounts.agentId, agent.id),
        eq(accounts.station, station),
        eq(accounts.accountId, accountId),
      ),
    )
    .returning({ accountId: accounts.accountId });
  if (gone.length === 0)
    throw new AgentAdminError('no such account on this agent', 404);
  return { agentId: agent.id, station, accountId };
}
