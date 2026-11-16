import { runWorkosSync } from '../src/workos-sync/run.js';

process.exitCode = await runWorkosSync(process.argv.slice(2), process.env, (text) => {
  process.stdout.write(text);
});
