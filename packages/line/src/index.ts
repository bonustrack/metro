import { errMsg } from '@metro-labs/mcp/log';
import { drainLines } from '@metro-labs/mcp/trains/protocol';
import { type CallMsg } from '@metro-labs/mcp/stations/station-runtime';
import { accounts, loadAccounts } from './accounts.js';
import { handleCall } from './actions.js';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: Buffer | string) => {
  buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  buf = drainLines('line', buf, (line) => {
    try {
      const msg = JSON.parse(line) as Partial<CallMsg>;
      if (msg.op === 'call') void handleCall(msg as CallMsg);
    } catch (err: unknown) {
      process.stderr.write(`bad stdin line: ${errMsg(err)}\n`);
    }
  });
});

for (const cfg of loadAccounts()) accounts.set(cfg.id, cfg);
if (accounts.size === 0) {
  process.stderr.write('line: no accounts booted, exiting\n');
  process.exit(2);
}
process.stderr.write(
  `line train ready (outbound push) — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
);
