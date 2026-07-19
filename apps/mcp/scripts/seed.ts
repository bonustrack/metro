// ONE-TIME migration helper (not a runtime path): loads the CURRENT agent + its
// accounts from the present env vars into Postgres, so an existing env-configured
// Metro keeps working once it switches to DB-only. The daemon NEVER reads these env
// vars at runtime — only this script does, once. Reads secrets from env; commits none.
//
//   DATABASE_URL=postgres://... \
//   MNEMONIC=... TELEGRAM_BOT_TOKENS=... DISCORD_BOT_TOKENS=... \
//   [METRO_AGENT=Tony] [METRO_MCP_HTTP_TOKEN=...] \
//   bun apps/mcp/scripts/seed.ts
import { getDb, closeDb } from '../src/db/client.js';
import { accounts, agents, keys } from '../src/db/schema.js';

type Row = {
  station: 'xmtp' | 'telegram' | 'telegram-user' | 'discord';
  accountId: string;
  config: Record<string, unknown>;
};

function csv(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function collectAccounts(): Row[] {
  const rows: Row[] = [];

  const mnemonic = process.env.MNEMONIC?.trim();
  if (mnemonic) {
    const n = Number(process.env.DERIVE_COUNT ?? '1') || 1;
    for (let i = 0; i < n; i++)
      rows.push({
        station: 'xmtp',
        accountId: `x${i}`,
        config: { mnemonic, derive: i },
      });
  }

  csv(process.env.TELEGRAM_BOT_TOKENS).forEach((token, i) =>
    rows.push({ station: 'telegram', accountId: `t${i}`, config: { token } }),
  );

  csv(process.env.DISCORD_BOT_TOKENS).forEach((token, i) =>
    rows.push({ station: 'discord', accountId: `d${i}`, config: { token } }),
  );

  const session = process.env.TELEGRAM_USER_SESSION?.trim();
  const apiId = Number(process.env.TELEGRAM_USER_API_ID);
  const apiHash = process.env.TELEGRAM_USER_API_HASH?.trim();
  if (session && apiHash && Number.isInteger(apiId) && apiId > 0)
    rows.push({
      station: 'telegram-user',
      accountId: 'default',
      config: { session, apiId, apiHash },
    });

  return rows;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL unset');
  const db = getDb();
  const name = process.env.METRO_AGENT?.trim() || 'Tony';

  await db.insert(agents).values({ name }).onConflictDoNothing();

  const rows = collectAccounts();
  for (const r of rows)
    await db
      .insert(accounts)
      .values({ agent: name, ...r })
      .onConflictDoNothing({ target: [accounts.station, accounts.accountId] });

  const token = process.env.METRO_MCP_HTTP_TOKEN?.trim();
  if (token)
    await db
      .insert(keys)
      .values({ agent: name, name: 'mcp-http', key: token })
      .onConflictDoNothing({ target: [keys.agent, keys.name] });

  console.log(
    `seeded agent '${name}' with ${rows.length} account(s): ` +
      rows.map((r) => `${r.station}/${r.accountId}`).join(', '),
  );
  await closeDb();
}

await main();
