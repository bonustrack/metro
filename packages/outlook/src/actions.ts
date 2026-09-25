import { makeStation, respond } from '@metro-labs/core/stations/station-runtime';
import { accounts } from './accounts.js';
import { MAILBOX_URL } from './config.js';
import { reply, send } from './outbound.js';
import { read } from './query.js';

function listAccounts(id: string): void {
  const list = [...accounts.values()].map((a) => ({ id: a.id, handle: a.email, url: MAILBOX_URL, email: a.email }));
  respond(id, { result: { accounts: list } });
}

export const handleCall = makeStation({
  handlers: { accounts: listAccounts, send, reply, read },
});
