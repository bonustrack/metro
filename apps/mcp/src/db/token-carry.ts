import { existsSync, readFileSync } from 'node:fs';
import { tokenStorePath } from '@metro-labs/whatsapp/tokens';
import { errMsg, log } from '../daemon/log.js';
import { writeSecure } from '../daemon/secure-fs.js';

export const PREVIOUS_ACCOUNT_ID = 'previousAccountId';

export interface CarriedStation {
  station: string;
  id: string;
  config: Record<string, unknown>;
}

export function previousAccountId(
  config: Record<string, unknown>,
): string | undefined {
  const raw = config[PREVIOUS_ACCOUNT_ID];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

export function carryTokenStores(list: CarriedStation[]): number {
  let carried = 0;
  for (const s of list) {
    if (s.station !== 'whatsapp') continue;
    const previous = previousAccountId(s.config);
    if (previous === undefined || previous === s.id) continue;
    const from = tokenStorePath(previous);
    const to = tokenStorePath(s.id);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      writeSecure(to, readFileSync(from, 'utf8'));
      carried += 1;
      log.info(
        { from: previous, to: s.id },
        'db: carried the whatsapp token store to the station id',
      );
    } catch (err) {
      log.error(
        { from: previous, to: s.id, err: errMsg(err) },
        'db: could not carry the whatsapp token store',
      );
    }
  }
  return carried;
}
