import { log } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import { rootHelper, rootStepHint, type HelperResult } from './privilege.js';

export function blockImds(run: (args: string[]) => HelperResult = rootHelper): boolean {
  const result = run(['imds-block']);
  if (result.status === 0) {
    log.info('imds: only root and metro reach the instance metadata service');
    return true;
  }
  log.warn(
    { err: result.stderr.trim(), fix: rootStepHint(METRO_VERSION) },
    'imds: the agent can still read the instance metadata (setup data, instance role), since the root helper on this box predates the guard',
  );
  return false;
}
