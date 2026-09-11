import { describe, expect, test } from 'bun:test';
import { cloudInit } from '../src/aws/user-data.ts';

const SPEC = {
  hostname: 'andy',
  node: 'metro-andy',
  owner: '0xef8305e140ac520225daf050e2f71d5fbcc543e7',
  tailscaleAuthKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  metroTag: 'beta',
};

describe('the first-boot script', () => {
  test('installs everything and ends by installing the metro service for the owner', () => {
    const script = cloudInit(SPEC);
    const lines = script.trim().split('\n');
    expect(lines[0]).toBe('#!/bin/bash');
    expect(script).toContain("hostnamectl set-hostname 'andy'");
    expect(script).toContain('deb.nodesource.com/setup_22.x');
    expect(script).toContain('apt-get -o DPkg::Lock::Timeout=600 install -y nodejs');
    expect(script).toContain('https://bun.sh/install');
    expect(script).toContain('https://claude.ai/install.sh');
    expect(script).toContain('https://tailscale.com/install.sh');
    expect(script).toContain("tailscale up --auth-key='tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop' --hostname='metro-andy' --ssh");
    expect(script).toContain("npm install -g '@stage-labs/metro@beta'");
    expect(script).toContain("'metro-andy' > /root/.metro/agents/.node");
    expect(lines[lines.length - 2]).toBe("metro service install --owner '0xef8305e140ac520225daf050e2f71d5fbcc543e7'");
    expect(script.split('tskey-').length).toBe(2);
    const marks = script.split('\n').filter((l) => l.startsWith('echo "metro setup: step')).map((l) => l.slice(24, -1));
    expect(marks).toEqual(['packages', 'node', 'bun', 'claude', 'tailscale', 'metro', 'service']);
  });

  test('bun and claude are put where the metro service PATH finds them', () => {
    const script = cloudInit(SPEC);
    expect(script).toContain('ln -sf /root/.bun/bin/bun /usr/local/bin/bun');
    expect(script).toContain('ln -sf /root/.local/bin/claude /usr/local/bin/claude');
    expect(script).toContain('export HOME=/root');
  });

  test('a value the script could not carry safely is refused before anything is built', () => {
    for (const [over, what] of [
      [{ owner: '0xEF8305E140AC520225DAF050E2F71D5FBCC543E7' }, 'owner wallet'],
      [{ owner: '' }, 'owner wallet'],
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
