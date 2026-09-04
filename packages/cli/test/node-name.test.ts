import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentNodeLabel, ensureNodeName, newNodeName, nodeName } from '../src/node-name.js';

let dir = '';
let bin = '';
let calls = '';

function fakeTailscale(dnsName: string, setExit = 0): void {
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "status" ]; then echo '{"Self":{"DNSName":"${dnsName}"}}'; exit 0; fi\necho "$*" >> ${calls}\nexit ${String(setExit)}\n`,
  );
  chmodSync(bin, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-node-'));
  bin = join(dir, 'tailscale');
  calls = join(dir, 'calls.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the machine name on the tailnet', () => {
  test('is generated once, kept in the agents dir, and never derived from the agent or the box', () => {
    const agents = join(dir, 'agents');
    const first = nodeName(agents);
    expect(first).toMatch(/^metro-[a-z0-9]{6}$/);
    expect(nodeName(agents)).toBe(first);
    expect(readFileSync(join(agents, '.node'), 'utf8').trim()).toBe(first);
    expect(newNodeName()).not.toBe(newNodeName());
  });

  test('a machine named otherwise is renamed once; a machine already named is left alone', () => {
    const agents = join(dir, 'agents');
    fakeTailscale('tony.tail1234.ts.net.');
    const name = ensureNodeName(bin, agents);
    expect(readFileSync(calls, 'utf8').trim()).toBe(`set --hostname ${name}`);
    fakeTailscale(`${name}.tail1234.ts.net.`);
    expect(ensureNodeName(bin, agents)).toBe(name);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(currentNodeLabel(bin)).toBe(name);
  });

  test('a refused rename says what to run by hand', () => {
    fakeTailscale('tony.tail1234.ts.net.', 1);
    expect(() => ensureNodeName(bin, join(dir, 'agents'))).toThrow(/sudo tailscale set --hostname metro-/);
  });
});
