import { makeStation, respond } from '@metro-labs/core/stations/station-runtime';
import { accountOf, accounts } from './accounts.js';
import { listChannels } from './channels.js';
import { MAILBOX_URL } from './config.js';
import { reply, send } from './outbound.js';
import { read } from './query.js';

function listAccounts(id: string): void {
  const list = [...accounts.values()].map((a) => ({ id: a.id, handle: a.email, url: `${MAILBOX_URL}mail/u/${a.email}/`, email: a.email, managed: a.cfg.managed === true, ...(a.cfg.sendEnabled === undefined ? {} : { sendEnabled: a.cfg.sendEnabled }) }));
  respond(id, { result: { accounts: list } });
}

async function disconnect(id: string, args: Record<string, unknown>): Promise<void> {
  await accountOf(args).disconnect(args.authorizationId);
  respond(id, { result: { revoked: true } });
}

export const handleCall = makeStation({
  handlers: { accounts: listAccounts, listChannels, send, reply, read, disconnect },
});
