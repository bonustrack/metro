import { existsSync, readFileSync } from 'node:fs';
import { tokenStorePath } from '@metro-labs/whatsapp/tokens';
import { errMsg, log } from '../daemon/log.js';
import { writeSecure } from '../daemon/secure-fs.js';

export interface CarriedStation {
  station: string;
  accountId: string;
  id: string;
}

export function carryTokenStores(list: CarriedStation[]): number {
  let carried = 0;
  for (const s of list) {
    if (s.station !== 'whatsapp' || s.accountId === s.id) continue;
    const from = tokenStorePath(s.accountId);
    const to = tokenStorePath(s.id);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      writeSecure(to, readFileSync(from, 'utf8'));
      carried += 1;
      log.info(
        { from: s.accountId, to: s.id },
        'db: carried the whatsapp token store to the station id',
      );
    } catch (err) {
      log.error(
        { from: s.accountId, to: s.id, err: errMsg(err) },
        'db: could not carry the whatsapp token store',
      );
    }
  }
  return carried;
}
