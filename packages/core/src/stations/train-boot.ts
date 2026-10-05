import { errMsg, logFatalSync } from '../log.js';
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
  disconnectClient?: (client: C) => Promise<void>;
  makeHandleCall: (clientFor: (accountId: string) => C) => (msg: CallMsg) => Promise<void>;
}

export function runClientTrain<A extends { id: string }, C>(train: ClientTrain<A, C>): void {
  const clients = new Map<string, C>();
  let stopping = false;
  if (train.disconnectClient) {
    const disconnect = train.disconnectClient;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      process.stdin.pause();
      Promise.allSettled([...clients.values()].map(async (client) => { await disconnect(client); })).then((results) => {
        const errors = results.flatMap((result) => result.status === 'rejected' ? [errMsg(result.reason)] : []);
        if (errors.length) logFatalSync({ station: train.station, errors }, 'train: shutdown failed');
        process.exit(errors.length ? 1 : 0);
      }).catch((err: unknown) => {
        logFatalSync({ station: train.station, err: errMsg(err) }, 'train: shutdown failed');
        process.exit(1);
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
  const clientFor = (accountId: string): C => {
    if (stopping) throw new TrainError('train_stopping', `${train.station} is shutting down`);
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
