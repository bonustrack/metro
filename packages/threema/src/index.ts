import { errMsg } from '@metro-labs/core/log';
import { readCalls } from '@metro-labs/core/trains/protocol';
import { announceAccounts } from '@metro-labs/core/stations/train-boot';
import { accounts, bootAccount, loadAccounts } from './accounts.js';
import { handleCall } from './actions.js';
import { fetchCredits } from './api.js';

readCalls('threema', handleCall);

for (const cfg of loadAccounts()) accounts.set(cfg.id, bootAccount(cfg));
announceAccounts('threema', accounts.keys());

for (const acct of accounts.values())
  fetchCredits(acct.cfg)
    .then((credits) => {
      process.stderr.write(
        `threema[${acct.cfg.id}] ${acct.cfg.gatewayId}: ${credits} credits left\n`,
      );
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `threema[${acct.cfg.id}] credits check failed: ${errMsg(err)}\n`,
      );
    });
