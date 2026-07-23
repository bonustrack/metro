import { TrainError } from '@metro-labs/mcp/train-error';
import {
  makeStation,
  respond,
  type CallMsg,
  type StationHandler,
} from '@metro-labs/mcp/stations/station-runtime';
import { accountFor, accounts, targetOf } from './accounts.js';
import { normalizeLine } from './normalize.js';
import { pushText } from './client.js';
import type { LineAccount } from './types.js';

type Args = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

interface Resolved {
  accountId: string;
  account: LineAccount;
  sourceId: string;
}

function resolve(args: Args): Resolved {
  const line = str(args.line);
  if (!line) throw new TrainError('bad_request', 'missing line');
  const target = targetOf(line);
  if (!target) throw new TrainError('bad_request', `bad line '${line}'`);
  const accountId = accountFor({ account: str(args.account), line });
  const account = accounts.get(accountId);
  if (!account)
    throw new TrainError('not_implemented', `unknown account '${accountId}'`);
  return { accountId, account, sourceId: target.sourceId };
}

const send: StationHandler = async (id, args) => {
  const { accountId, account, sourceId } = resolve(args);
  const text = str(args.text) ?? '';
  await pushText(account, sourceId, text);
  respond(id, { result: { ok: true, account: accountId } });
};

const listAccounts: StationHandler = (id) => {
  const list = [...accounts.values()].map((a) => ({
    id: a.id,
    owner: a.owner ?? null,
  }));
  respond(id, { result: { accounts: list } });
  return Promise.resolve();
};

export const handleCall: (msg: CallMsg) => Promise<void> = makeStation({
  handlers: { accounts: listAccounts, send },
  normalize: normalizeLine,
});
