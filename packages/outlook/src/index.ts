import { readCalls } from '@metro-labs/core/trains/protocol';
import { announceAccounts } from '@metro-labs/core/stations/train-boot';
import { Account, accounts, loadAccounts } from './accounts.js';
import { handleCall } from './actions.js';
import { startPolling } from './inbound.js';

readCalls('outlook', handleCall);

for (const cfg of loadAccounts()) accounts.set(cfg.id, new Account(cfg));
announceAccounts('outlook', accounts.keys());

for (const acct of accounts.values()) startPolling(acct);
