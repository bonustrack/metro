import { errMsg } from '../log.js';
import { readCalls } from '../protocol.js';
import { TrainError } from '../train-error.js';
import type { CallMsg } from './station-runtime.js';

export function announceAccounts(station: string, ids: Iterable<string>): void {
  const list = [...ids];
  if (list.length === 0) {
    process.stderr.write(`${station}: no accounts booted, exiting\n`);
    process.exit(2);
  }
  process.stderr.write(`${station} train ready — ${String(list.length)} account(s): ${list.join(', ')}\n`);
}

export interface ClientTrain<A extends { id: string }, C> {
  station: string;
  accounts: Map<string, A>;
  loadAccounts: () => A[];
  createClient: (account: A) => C;
  startInbound: (client: C) => Promise<void>;
  makeHandleCall: (clientFor: (accountId: string) => C) => (msg: CallMsg) => Promise<void>;
}

export function runClientTrain<A extends { id: string }, C>(train: ClientTrain<A, C>): void {
  const clients = new Map<string, C>();
  const clientFor = (accountId: string): C => {
    const known = clients.get(accountId);
    if (known !== undefined) return known;
    const account = train.accounts.get(accountId);
    if (!account) throw new TrainError('not_implemented', `unknown account '${accountId}'`);
    const client = train.createClient(account);
    clients.set(accountId, client);
    return client;
  };
  readCalls(train.station, train.makeHandleCall(clientFor));
  for (const cfg of train.loadAccounts()) train.accounts.set(cfg.id, cfg);
  for (const id of train.accounts.keys())
    train.startInbound(clientFor(id)).catch((err: unknown) => {
      process.stderr.write(`${train.station}[${id}] inbound failed: ${errMsg(err)}\n`);
    });
  announceAccounts(train.station, train.accounts.keys());
}
