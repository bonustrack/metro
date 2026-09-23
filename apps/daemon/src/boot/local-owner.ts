import { localOwner, setLocalOwner } from '../agents/file-admin.js';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import { log } from '@metro-labs/core/log';

export function applyLocalOwner(): string | null {
  const wanted = process.env.METRO_OWNER?.trim() ?? '';
  const stored = localOwner();
  if (stored !== null) {
    if (wanted !== '' && wanted !== stored)
      log.info({ owner: stored, ignored: wanted }, 'local daemon: this machine already belongs to an organization, so --owner is ignored');
    return stored;
  }
  if (isOrganizationId(wanted)) {
    const owner = setLocalOwner(wanted);
    log.info({ owner }, 'local daemon: owner set from METRO_OWNER');
    return owner;
  }
  if (wanted !== '') log.info({ ignored: wanted }, 'local daemon: --owner is not an organization id, so it is ignored');
  log.warn('local daemon: no organization owns this machine, so nobody can sign in; restart with metro serve --owner <organization id>');
  return null;
}
