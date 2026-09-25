import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSecret, readVault, removeSecret, setVaultEnabled, updateSecret } from '../src/vault/store.ts';
import { proxyConfig, proxyEnvFor } from '../src/vault/config.ts';
import { applyFirewall, removeFirewall, type FirewallRunner } from '../src/vault/firewall.ts';
import { archiveName, expectedSum } from '../src/vault/install.ts';
import { requestOf } from '../src/vault/proxy.ts';
import { valueFile } from '../src/vault/paths.ts';
import { withCronEnv } from '../src/agent-user/job-env.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'metro-vault-'));

describe('the secrets the agent never sees', () => {
  test('a secret keeps its value in a private file and only its placeholder in the list', () => {
    const d = dir();
    const s = addSecret({ name: 'OpenAI', env: 'OPENAI_API_KEY', hosts: ['https://API.openai.com/v1', 'api.openai.com'], value: ' sk-real \n' }, d);
    expect(s).toMatchObject({ name: 'OpenAI', env: 'OPENAI_API_KEY', hosts: ['api.openai.com'] });
    expect(readFileSync(valueFile(s.id, d), 'utf8')).toBe('sk-real');
    expect(statSync(valueFile(s.id, d)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(readVault(d))).not.toContain('sk-real');
    updateSecret(s.id, { hosts: ['*.openai.com'], value: 'sk-new' }, d);
    expect(readVault(d).secrets[0]?.hosts).toEqual(['*.openai.com']);
    expect(readFileSync(valueFile(s.id, d), 'utf8')).toBe('sk-new');
    removeSecret(s.id, d);
    expect(existsSync(valueFile(s.id, d))).toBe(false);
    expect(readVault(d).secrets).toEqual([]);
  });

  test('names, websites and values are checked', () => {
    const d = dir();
    const ok = { env: 'TOKEN_A', hosts: ['a.example.com'], value: 'v' };
    expect(() => addSecret({ ...ok, env: 'lower' }, d)).toThrow(/capital letters/);
    expect(() => addSecret({ ...ok, env: 'PATH' }, d)).toThrow(/capital letters/);
    expect(() => addSecret({ ...ok, hosts: [] }, d)).toThrow(/websites/);
    expect(() => addSecret({ ...ok, hosts: ['not a host'] }, d)).toThrow(/not a website/);
    expect(() => addSecret({ ...ok, value: '' }, d)).toThrow(/value/);
    addSecret(ok, d);
    expect(() => addSecret(ok, d)).toThrow(/already/);
    expect(setVaultEnabled(true, d).enabled).toBe(true);
  });

  test('the proxy swaps each placeholder only on its own websites, and listens inside the box only', () => {
    const d = dir();
    const s = addSecret({ env: 'GITHUB_TOKEN', hosts: ['api.github.com'], value: 'ghp' }, d);
    const config = proxyConfig([s], d);
    expect(JSON.stringify(config)).not.toContain('0.0.0.0');
    expect(config.transforms).toEqual([
      { name: 'secrets', config: { secrets: [{ source: { type: 'file', path: valueFile(s.id, d) }, replace: { proxy_value: 'GITHUB_TOKEN', match_headers: [], match_query: true }, rules: [{ host: 'api.github.com' }] }] } },
    ]);
    const env = proxyEnvFor('/ca.crt', '/bundle.crt', [s]);
    expect(env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:8421', NO_PROXY: 'localhost,127.0.0.1,::1', NODE_EXTRA_CA_CERTS: '/ca.crt', GITHUB_TOKEN: 'GITHUB_TOKEN' });
  });

  test("the firewall only touches the agent's own traffic and comes off cleanly", () => {
    const calls: string[] = [];
    const runner: FirewallRunner = { run: (file, args) => (calls.push(`${file} ${args.join(' ')}`), args[0] === '-C' ? 1 : 0) };
    applyFirewall(1001, runner);
    expect(calls).toContain('iptables -I OUTPUT -m owner --uid-owner 1001 -j METRO_AGENT');
    expect(calls).toContain('ip6tables -A METRO_AGENT -o lo -j ACCEPT');
    expect(calls.filter((c) => c.includes('REJECT')).length).toBe(4);
    calls.length = 0;
    removeFirewall(1001, runner);
    expect(calls).toContain('iptables -X METRO_AGENT');
  });

  test('the download is checked against its published sum', () => {
    const sums = `${'a'.repeat(64)}  ${archiveName('x64')}\n${'b'.repeat(64)}  other.tar.gz\n`;
    expect(expectedSum(sums, archiveName('x64'))).toBe('a'.repeat(64));
    expect(archiveName('arm64')).toContain('linux_arm64');
    expect(expectedSum(sums, 'missing.tar.gz')).toBeNull();
  });

  test('the request log reads what iron-proxy prints, and which secret it swapped', () => {
    const line = JSON.stringify({
      time: 't',
      msg: 'request',
      audit: { host: 'httpbin.org', method: 'GET', path: '/anything', status_code: 200, action: 'allow' },
      request_transforms: [{ name: 'secrets', annotations: { swapped: [{ secret: '/root/.metro/agents/vault/values/abc', locations: ['header:Authorization'] }] } }],
    });
    expect(requestOf(line)).toEqual({ at: 't', method: 'GET', host: 'httpbin.org', path: '/anything', status: 200, action: 'allow', swapped: ['abc'] });
    expect(requestOf(JSON.stringify({ msg: 'request', audit: { method: 'CONNECT' } }))).toBeNull();
    expect(requestOf('not json')).toBeNull();
  });

  test("the agent's crontab gets one settings block, replaced or removed, never doubled", () => {
    const first = withCronEnv(['0 3 * * * /x.sh', ''], { HTTPS_PROXY: 'http://p' });
    expect(first).toEqual(['# metro vault: begin', 'HTTPS_PROXY=http://p', '# metro vault: end', '0 3 * * * /x.sh']);
    expect(withCronEnv(first, { HTTPS_PROXY: 'http://q' })).toEqual(['# metro vault: begin', 'HTTPS_PROXY=http://q', '# metro vault: end', '0 3 * * * /x.sh']);
    expect(withCronEnv(first, {})).toEqual(['0 3 * * * /x.sh']);
  });
});
