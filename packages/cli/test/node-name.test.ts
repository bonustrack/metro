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
  process.env.METRO_NODE_RENAME_WAIT_MS = '700';
  dir = mkdtempSync(join(tmpdir(), 'metro-node-'));
  bin = join(dir, 'tailscale');
  calls = join(dir, 'calls.log');
});

afterEach(() => {
  delete process.env.METRO_NODE_RENAME_WAIT_MS;
  rmSync(dir, { recursive: true, force: true });
});

function fakeRenamingTailscale(agents: string): string {
  const count = join(dir, 'status-count');
  const renamed = `{\\"Self\\":{\\"DNSName\\":\\"$(cat ${agents}/.node).tail1234.ts.net.\\"}}`;
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "status" ]; then',
      `  if [ -f ${calls} ]; then n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}; if [ $n -ge 2 ]; then echo "${renamed}"; exit 0; fi; fi`,
      `  echo '{"Self":{"DNSName":"tony.tail1234.ts.net."}}'; exit 0`,
      'fi',
      `echo "$*" >> ${calls}`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return count;
}

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
    const name = ensureNodeName(bin, agents, () => undefined);
    expect(readFileSync(calls, 'utf8').trim()).toBe(`set --hostname ${name}`);
    fakeTailscale(`${name}.tail1234.ts.net.`);
    expect(ensureNodeName(bin, agents)).toBe(name);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(currentNodeLabel(bin)).toBe(name);
  });

  test('the daemon starts only once tailscale reports the new name, so the funnel never announces the old one', () => {
    const agents = join(dir, 'agents');
    const count = fakeRenamingTailscale(agents);
    const warned: string[] = [];
    const name = ensureNodeName(bin, agents, (line) => {
      warned.push(line);
    });
    expect(readFileSync(count, 'utf8').trim()).toBe('2');
    expect(currentNodeLabel(bin)).toBe(name);
    expect(warned).toEqual([]);
  });

  test('a rename tailscale never reports is given up on after the wait, with a warning, not a refusal', () => {
    fakeTailscale('tony.tail1234.ts.net.');
    const warned: string[] = [];
    const started = Date.now();
    const name = ensureNodeName(bin, join(dir, 'agents'), (line) => {
      warned.push(line);
    });
    expect(name).toMatch(/^metro-/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('still reports the old machine name');
  });

  test('a refused rename says what to run by hand', () => {
    fakeTailscale('tony.tail1234.ts.net.', 1);
    expect(() => ensureNodeName(bin, join(dir, 'agents'))).toThrow(/sudo tailscale set --hostname metro-/);
  });
});
