import { log } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import { rootHelper, rootStepHint, type HelperResult } from './privilege.js';

export function followRelease(run: (args: string[]) => HelperResult = rootHelper, version: string = METRO_VERSION): boolean {
  const result = run(['upgrade', version]);
  if (result.status === 0) {
    log.info({ version, journal: `journalctl -u metro-root-upgrade@${version}` }, 'root: asked the root side to follow this version');
    return true;
  }
  log.warn(
    { err: result.stderr.trim(), fix: rootStepHint(version) },
    'root: the root side cannot follow updates by itself yet, since the root helper on this box predates it',
  );
  return false;
}
