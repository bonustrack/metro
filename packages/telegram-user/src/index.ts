import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
import { drainLines } from '@metro-labs/mcp/trains/protocol';
import {
  makeStation,
  respond,
  type CallMsg,
} from '@metro-labs/mcp/stations/station-runtime';
import type { Normalized } from '@metro-labs/mcp/stations/messaging-normalize';
import { SELF_URI } from './wire.js';
import {
  accounts,
  loadAccounts,
  accountFor,
  lineOf,
  targetOf,
} from './accounts.js';
import { createClient, type UserClient } from './client.js';
import { startInbound } from './inbound.js';

type Args = Record<string, unknown>;

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

const notImplemented = (id: string): void => {
  const err = new TrainError('not_implemented', `telegram-user is scaffold-only (${SELF_URI})`);
  respond(id, { errorInfo: err.toErrorInfo() });
};

const normalize = (action: string, args: Args): Normalized => ({ action, args });

const handleCall = makeStation({
  handlers: {
    send: (id) => {
      notImplemented(id);
    },
    reply: (id) => {
      notImplemented(id);
    },
    react: (id) => {
      notImplemented(id);
    },
    unreact: (id) => {
      notImplemented(id);
    },
    edit: (id) => {
      notImplemented(id);
    },
    delete: (id) => {
      notImplemented(id);
    },
    read: (id) => {
      notImplemented(id);
    },
  },
  normalize,
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: Buffer | string) => {
  buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  buf = drainLines('telegram-user', buf, (line) => {
    try {
      const msg = JSON.parse(line) as Partial<CallMsg>;
      if (msg.op === 'call') void handleCall(msg as CallMsg);
    } catch (err: unknown) {
      process.stderr.write(`bad stdin line: ${errMsg(err)}\n`);
    }
  });
});

function boot(): void {
  for (const cfg of loadAccounts()) accounts.set(cfg.id, cfg);
  for (const id of accounts.keys()) void startInbound(clientFor(id));
  process.stderr.write(
    `telegram-user train ready (inbound) — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
  );
}

boot();

export {
  clients,
  accounts,
  clientFor,
  accountFor,
  lineOf,
  targetOf,
};
