import { errMsg } from '@metro-labs/core/log';
import { readCalls } from '@metro-labs/core/trains/protocol';
import { accounts, bootAccount, loadAccounts } from './accounts.js';
import { handleCall } from './actions.js';
import { fetchCredits } from './api.js';

readCalls('threema', handleCall);

for (const cfg of loadAccounts()) accounts.set(cfg.id, bootAccount(cfg));
if (accounts.size === 0) {
  process.stderr.write('threema: no accounts booted, exiting\n');
  process.exit(2);
}
process.stderr.write(
  `threema train ready — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
);

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
