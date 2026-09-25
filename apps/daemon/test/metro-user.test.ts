import { describe, expect, test } from 'bun:test';
import { metroUnit, moveScript, unitFacts } from '../src/metro-user/move.ts';
import { helperScript, sudoersText } from '../src/metro-user/helper-script.ts';
import { runningAsMetro, runningAsRoot } from '../src/metro-user/privilege.ts';

const ROOT_UNIT = [
  '[Service]',
  'ExecStart=/usr/bin/node /usr/lib/node_modules/@stage-labs/metro/dist/cli.js serve --owner org_01ABC --port 8430',
  'Environment=HOME=/root',
  'Environment=PATH=/root/.bun/bin:/usr/bin',
  'Environment=METRO_WEBHOOK_PORT=8430',
  'Environment=METRO_AGENTS_DIR=/root/.metro/agents',
  'Environment="METRO_NOTE=a b"',
  '',
].join('\n');

describe('moving Metro from root to its own user', () => {
  test('the old service is read for its serve arguments, its port and its Metro settings, never its root paths', () => {
    const facts = unitFacts(ROOT_UNIT);
    expect(facts).toEqual({ serveArgs: ['--owner', 'org_01ABC', '--port', '8430'], env: ['METRO_WEBHOOK_PORT=8430', '"METRO_NOTE=a b"'], port: '8430' });
    expect(() => unitFacts('[Service]\nExecStart=/usr/bin/other\n')).toThrow(/metro serve/);
  });

  test('the new service runs as metro, from its own CLI, with no path under /root', () => {
    const unit = metroUnit('/usr/bin/node', unitFacts(ROOT_UNIT));
    expect(unit).toContain('User=metro\nGroup=metro\n');
    expect(unit).toContain('ExecStart=/usr/bin/node /var/lib/metro/.npm-global/lib/node_modules/@stage-labs/metro/dist/cli.js serve --owner org_01ABC --port 8430\n');
    expect(unit).toContain('Environment=HOME=/var/lib/metro\n');
    expect(unit).toContain('Environment=NPM_CONFIG_PREFIX=/var/lib/metro/.npm-global\n');
    expect(unit).toContain('OOMPolicy=continue');
    expect(unit).not.toContain('/root');
  });

  test('the move puts everything back when Metro does not come up as metro', () => {
    const script = moveScript('8430', '@stage-labs/metro@0.1.0-beta.199', '/root/.bun/bin/bun');
    expect(script).toContain("B='/root/.bun/bin/bun'; case \"$B\" in /root/*) install -m 755 \"$B\" /usr/local/bin/bun");
    expect(script.indexOf('cannot find $bin')).toBeLessThan(script.indexOf('systemctl stop metro'));
    expect(script).toContain('http://127.0.0.1:8430/health');
    expect(script).toContain("npm install --global --prefix /var/lib/metro/.npm-global @stage-labs/metro@0.1.0-beta.199");
    expect(script.indexOf('fail "npm install')).toBeLessThan(script.indexOf('systemctl stop metro'));
    expect(script).toContain('mv "$NEW" "$OLD" && chown -R root:root "$OLD"');
    expect(script).toContain('install -m 644 "$DIR/metro.service.root"');
  });

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

  test('root and metro are told apart by platform and user', () => {
    expect(runningAsRoot({ platform: 'linux', uid: 0, user: 'root' })).toBe(true);
    expect(runningAsRoot({ platform: 'darwin', uid: 0, user: 'root' })).toBe(false);
    expect(runningAsMetro({ platform: 'linux', uid: 994, user: 'metro' })).toBe(true);
    expect(runningAsMetro({ platform: 'linux', uid: 1000, user: 'less' })).toBe(false);
    expect(runningAsMetro({ platform: 'darwin', uid: 994, user: 'metro' })).toBe(false);
  });
});
