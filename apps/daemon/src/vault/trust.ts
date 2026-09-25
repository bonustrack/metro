import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { errMsg, log } from '@metro-labs/core/log';
import { asUser, type AgentUser } from '../agent-user/user.js';
import { TRUSTED_CA } from './paths.js';
import { mustHelper, rootHelper } from '../metro-user/privilege.js';

const has = (bin: string): boolean => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

export function trustSystem(caFile: string): void {
  const same = existsSync(TRUSTED_CA) && readFileSync(TRUSTED_CA, 'utf8') === readFileSync(caFile, 'utf8');
  if (!same) mustHelper(['trust-ca']);
}

export function untrustSystem(): void {
  if (existsSync(TRUSTED_CA)) mustHelper(['untrust-ca']);
}

const NSS_SCRIPT = [
  'set -e',
  'db="$HOME/.pki/nssdb"',
  'mkdir -p "$db"',
  '[ -f "$db/cert9.db" ] || certutil -d "sql:$db" -N --empty-password',
  'certutil -d "sql:$db" -D -n "Metro vault" >/dev/null 2>&1 || true',
  'certutil -d "sql:$db" -A -t "C,," -n "Metro vault" -i "$1"',
].join('\n');

function ensureCertutil(): boolean {
  if (has('certutil')) return true;
  return rootHelper(['install-nss-tools']).status === 0 && has('certutil');
}

export function trustBrowsers(user: AgentUser): string | null {
  try {
    if (!ensureCertutil()) return 'certutil is missing, so browsers the agent starts will not trust the vault (apt-get install libnss3-tools)';
    const [file, argv] = asUser(user, 'sh', ['-c', NSS_SCRIPT, 'metro', TRUSTED_CA]);
    const run = spawnSync(file, argv, { encoding: 'utf8', timeout: 30_000 });
    if (run.status !== 0) return `browsers will not trust the vault: ${run.stderr.trim()}`;
    return null;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'vault: could not add the certificate for browsers');
    return errMsg(err);
  }
}
