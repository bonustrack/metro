import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
import { readCalls } from '@metro-labs/mcp/trains/protocol';
import {
  accounts,
  loadAccounts,
  accountFor,
  lineOf,
  targetOf,
} from './accounts.js';
import { createClient, type UserClient } from './client.js';
import { startInbound } from './inbound.js';
import { makeHandleCall } from './actions.js';

const clients = new Map<string, UserClient>();

function clientFor(accountId: string): UserClient {
  let client = clients.get(accountId);
  if (!client) {
    const account = accounts.get(accountId);
    if (!account)
      throw new TrainError('not_implemented', `unknown account '${accountId}'`);
    client = createClient(account);
    clients.set(accountId, client);
  }
  return client;
}

const handleCall = makeHandleCall(clientFor);

readCalls('telegram-user', handleCall);

function boot(): void {
  for (const cfg of loadAccounts()) accounts.set(cfg.id, cfg);
  for (const id of accounts.keys())
    startInbound(clientFor(id)).catch((err: unknown) => {
      process.stderr.write(`telegram-user[${id}] inbound failed: ${errMsg(err)}\n`);
    });
  process.stderr.write(
    `telegram-user train ready (inbound+outbound) — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
  );
}

boot();

export { clients, accounts, clientFor, accountFor, lineOf, targetOf };
