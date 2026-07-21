import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../daemon/paths.js';
import { log } from '../daemon/log.js';
import { countWhatsappAuth, writeWhatsappAuth } from './whatsapp-auth.js';

function credsPath(accountId: string): string {
  return join(STATE_DIR, 'whatsapp', accountId, 'creds.json');
}

export async function importWhatsappCredsIfEmpty(
  accountId: string,
): Promise<void> {
  if ((await countWhatsappAuth(accountId)) > 0) return;
  const path = credsPath(accountId);
  if (!existsSync(path)) return;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  await writeWhatsappAuth(accountId, [{ category: 'creds', itemId: '', value }]);
  log.info(
    { account: accountId, path },
    'whatsapp: imported file creds into DB (one-time); files no longer needed',
  );
}
