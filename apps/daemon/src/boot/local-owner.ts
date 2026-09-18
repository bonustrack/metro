import { localOwner, setLocalOwner } from '../agents/file-admin.js';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import { log } from '@metro-labs/core/log';

const NO_ONE = 'nobody can sign in; restart with metro serve --owner <organization id>';

const WALLET = `the owner is a wallet address, and wallets cannot sign in any more; ${NO_ONE}`;

function keepsOrganization(wanted: string, stored: string | null): stored is string {
  return wanted !== '' && stored !== null && isOrganizationId(stored) && !isOrganizationId(wanted);
}

function announce(owner: string | null): string | null {
  if (owner === null) log.warn(`local daemon: no owner set, so ${NO_ONE}`);
  else if (!isOrganizationId(owner)) log.warn(`local daemon: ${WALLET}`);
  return owner;
}

export function applyLocalOwner(): string | null {
  const wanted = process.env.METRO_OWNER?.trim() ?? '';
  const stored = localOwner();
  if (keepsOrganization(wanted, stored)) {
    log.info({ owner: stored, ignored: wanted }, 'local daemon: this machine belongs to an organization, so the wallet in --owner is ignored');
    return stored;
  }
  if (wanted === '') return announce(stored);
  const owner = setLocalOwner(wanted);
  log.info({ owner }, 'local daemon: owner set from METRO_OWNER');
  return announce(owner);
}
