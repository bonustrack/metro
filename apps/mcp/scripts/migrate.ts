import { errMsg, log } from '../src/daemon/log.js';
import { runMigrations } from '../src/db/migrate.js';

try {
  await runMigrations();
} catch (err) {
  log.error({ err: errMsg(err) }, 'migrate: FAILED — the deploy is aborted');
  process.exit(1);
}
