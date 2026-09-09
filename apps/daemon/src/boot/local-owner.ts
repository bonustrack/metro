import { localOwner, setLocalOwner } from '../agents/file-admin.js';
import { log } from '@metro-labs/core/log';

export function applyLocalOwner(): string | null {
  const wanted = process.env.METRO_OWNER?.trim() ?? '';
  if (wanted !== '') {
    const address = setLocalOwner(wanted);
    log.info({ owner: address }, 'local daemon: owner set from METRO_OWNER');
    return address;
  }
  const stored = localOwner();
  if (stored === null) log.warn('local daemon: no owner set, so no wallet can sign in; restart with metro serve --owner <address>');
  return stored;
}
