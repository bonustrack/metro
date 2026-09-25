import { describe, expect, test } from 'bun:test';
import { cloudInit } from '../src/aws/user-data.ts';

const SPEC = {
  hostname: 'andy',
  node: 'metro-andy',
  owner: 'org_01M2TNE064H99ECTG4X228Y6B6',
  tailscaleAuthKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  metroTag: 'beta',
};

describe('the first-boot script', () => {
  test('installs everything and ends by installing the metro service for the owner, run as the metro user', () => {
    const script = cloudInit(SPEC);
    const lines = script.trim().split('\n');
    expect(lines[0]).toBe('#!/bin/bash');
    expect(script).toContain("hostnamectl set-hostname 'andy'");
    expect(script).toContain('install -y curl ca-certificates git tmux unzip sudo iptables');
    expect(script).toContain('deb.nodesource.com/setup_22.x');
    expect(script).toContain('apt-get -o DPkg::Lock::Timeout=600 install -y nodejs');
    expect(script).toContain('https://tailscale.com/install.sh');
    expect(script).toContain("tailscale up --auth-key='tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop' --hostname='metro-andy' --ssh --operator=metro");
    expect(script).toContain("'metro-andy' > /var/lib/metro/.metro/agents/.node && chown metro:metro /var/lib/metro/.metro/agents/.node && chmod 600");
    expect(lines[lines.length - 2]).toBe("/var/lib/metro/.npm-global/bin/metro service install --owner 'org_01M2TNE064H99ECTG4X228Y6B6' --user metro");
    expect(script.split('tskey-').length).toBe(2);
    const marks = script.split('\n').filter((l) => l.startsWith('echo "metro setup: step')).map((l) => l.slice(24, -1));
    expect(marks).toEqual(['packages', 'node', 'bun', 'user', 'tailscale', 'metro', 'service']);
  });

  test('Metro gets its own user and its own CLI, and nothing lands under /root', () => {
    const script = cloudInit(SPEC);
    expect(script).toContain('curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash');
    expect(script).toContain('useradd --system --create-home --home-dir /var/lib/metro --shell /usr/sbin/nologin --groups systemd-journal metro');
    expect(script).toContain('chmod 711 /var/lib/metro');
    expect(script).toContain(`sudo -u metro -H sh -c "cd / && npm install --global --prefix /var/lib/metro/.npm-global '@stage-labs/metro@beta'"`);
    expect(script).toContain('install -d -o metro -g metro -m 700 /var/lib/metro/.metro /var/lib/metro/.metro/agents');
    expect(script).not.toContain('claude.ai/install.sh');
    expect(script.replace('export HOME=/root', '')).not.toContain('/root');
  });

  test('a value the script could not carry safely is refused before anything is built', () => {
    for (const [over, what] of [
      [{ owner: '0xEF8305E140AC520225DAF050E2F71D5FBCC543E7' }, 'owner'],
      [{ owner: '' }, 'owner'],
      [{ tailscaleAuthKey: "tskey-auth-x'; rm -rf /" }, 'Tailscale auth key'],
      [{ tailscaleAuthKey: 'tskey-api-kKv6QQKgh311CNTRL-abcdefghijklmnop' }, 'starts with tskey-auth-'],
      [{ tailscaleAuthKey: '' }, 'is required'],
      [{ node: 'metro-Andy' }, 'tailnet name'],
      [{ node: 'andy' }, 'tailnet name'],
      [{ hostname: "andy'" }, 'host name'],
      [{ metroTag: 'beta; reboot' }, 'metro version'],
    ] as const) {
      expect(() => cloudInit({ ...SPEC, ...over })).toThrow(what);
    }
  });
});
