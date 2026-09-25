import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperScript, sudoersText } from '../src/metro-user/helper-script.ts';
import { installRootHelper } from '../src/metro-user/install.ts';
import { runningAsMetro, runningAsRoot } from '../src/metro-user/privilege.ts';

const hasVisudo = spawnSync('sh', ['-c', 'command -v visudo'], { stdio: 'ignore' }).status === 0;

describe('Metro as its own user', () => {
  test('metro may act as the agent, and as root only through the helper', () => {
    const rules = sudoersText('agent');
    expect(rules).toContain('metro ALL=(agent) NOPASSWD: ALL');
    expect(rules).toContain('metro ALL=(root) NOPASSWD: /usr/local/lib/metro/root-helper *');
    expect(rules.split('\n').filter((l) => l.includes('(root)'))).toHaveLength(1);
  });

  test('the helper only knows its own actions and refuses privileged service lines', () => {
    const helper = helperScript();
    expect(helper).toContain('*) die "unknown action: $action"');
    expect(helper).toContain('ExecStart=[+!@]*) die "privileged ExecStart refused"');
    expect(helper).toContain('*) die "line not allowed: $line"');
    expect(helper).toContain('case "$1" in metro*) die "not a metro unit";; esac');
    expect(helper).not.toContain('eval');
  });

  test.skipIf(!hasVisudo)('the install writes the helper and the checked sudo rules from the one source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-helper-'));
    const paths = { helper: join(dir, 'lib', 'root-helper'), sudoers: join(dir, 'sudoers') };
    installRootHelper(paths);
    expect(readFileSync(paths.helper, 'utf8')).toBe(helperScript());
    expect(statSync(paths.helper).mode & 0o777).toBe(0o755);
    expect(readFileSync(paths.sudoers, 'utf8')).toBe(sudoersText('agent'));
    expect(statSync(paths.sudoers).mode & 0o777).toBe(0o440);
    expect(existsSync(join(dir, 'lib'))).toBe(true);
  });

  test('root and metro are told apart by platform and user', () => {
    expect(runningAsRoot({ platform: 'linux', uid: 0, user: 'root' })).toBe(true);
    expect(runningAsRoot({ platform: 'darwin', uid: 0, user: 'root' })).toBe(false);
    expect(runningAsMetro({ platform: 'linux', uid: 994, user: 'metro' })).toBe(true);
    expect(runningAsMetro({ platform: 'linux', uid: 1000, user: 'less' })).toBe(false);
    expect(runningAsMetro({ platform: 'darwin', uid: 994, user: 'metro' })).toBe(false);
  });
});
