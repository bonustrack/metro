import { errMsg } from '@metro-labs/mcp/log';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { accounts, loadAccounts, type AccountConfig } from './accounts.js';
import { attachHandlers } from './handlers.js';
import { drainLines } from '@metro-labs/mcp/trains/protocol';
import { handleCall, type CallMsg } from './actions.js';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  buf = drainLines('discord', buf, (line) => {
    try {
      const msg = JSON.parse(line) as CallMsg;
      if (msg.op === 'call')
        handleCall(msg).catch((e: unknown) => {
          process.stderr.write(`call failed: ${errMsg(e)}\n`);
        });
    } catch (err) {
      process.stderr.write(`bad stdin line: ${errMsg(err)}\n`);
    }
  });
});

function makeClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
    ],
  });
}

async function bootAccount(cfg: AccountConfig): Promise<void> {
  const client = makeClient();
  const accountId = cfg.id;

  attachHandlers(client, accountId);

  accounts.set(accountId, { cfg, client });
  await client.login(cfg.token);
  process.stderr.write(
    `discord[${accountId}] ready — ${client.user?.tag ?? '?'} (owner=${cfg.owner ?? '(broadcast)'})\n`,
  );
}

const cfgs = loadAccounts();
for (const cfg of cfgs) {
  try {
    await bootAccount(cfg);
  } catch (err) {
    process.stderr.write(
      `discord[${cfg.id}] boot FAILED: ${errMsg(err)}\n`,
    );
  }
}
if (accounts.size === 0) {
  process.stderr.write('discord: no accounts booted, exiting\n');
  process.exit(2);
}
process.stderr.write(
  `discord train ready — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
);
