import { spawnSync } from 'node:child_process';
import { agentExtraEnv, agentUser, asAgent } from '../../apps/daemon/src/agent-user/user.ts';
import { addSecret, setVaultEnabled } from '../../apps/daemon/src/vault/store.ts';
import { applyVault } from '../../apps/daemon/src/vault/index.ts';
import { recentRequests, stopProxy } from '../../apps/daemon/src/vault/proxy.ts';
import { valueFile } from '../../apps/daemon/src/vault/paths.ts';

const results: string[] = [];
const check = (what: string, ok: boolean): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};
const u = agentUser();
if (u === null) throw new Error('no agent user');
const asAgentOut = (script: string): { ok: boolean; out: string } => {
  const run = spawnSync(...asAgent('sh', ['-c', script]), { encoding: 'utf8', timeout: 60_000 });
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}` };
};

const secret = addSecret({ name: 'Httpbin', env: 'HTTPBIN_TOKEN', hosts: ['httpbin.org'], value: 'REAL-VALUE-42' });
setVaultEnabled(true);
const on = await applyVault(u);
check(`the vault turns on (${on.status.problem ?? 'no problem'}; browsers: ${on.status.browsers ?? 'trusted'})`, on.status.running && on.status.problem === null);
check('the agent gets the placeholder, not the value', agentExtraEnv().HTTPBIN_TOKEN === 'HTTPBIN_TOKEN');
check('the agent cannot read the stored value', !asAgentOut(`cat ${valueFile(secret.id)}`).ok);
const good = asAgentOut('/usr/bin/curl -s -m 30 -H "Authorization: Bearer $HTTPBIN_TOKEN" https://httpbin.org/headers');
check(`the right website gets the real value (${good.out.slice(0, 80).replace(/\s+/g, ' ')})`, good.out.includes('Bearer REAL-VALUE-42'));
const other = asAgentOut('/usr/bin/curl -s -m 30 -H "Authorization: Bearer $HTTPBIN_TOKEN" https://postman-echo.com/headers');
check('another website only gets the placeholder', other.out.includes('Bearer HTTPBIN_TOKEN') && !other.out.includes('REAL-VALUE-42'));
check('the agent cannot go around the proxy', !asAgentOut("/usr/bin/curl -s -m 10 --noproxy '*' https://httpbin.org/get").ok);
check('root still reaches the internet directly', spawnSync('/usr/bin/curl', ['-s', '-m', '20', '-o', '/dev/null', 'https://httpbin.org/get']).status === 0);
await new Promise((r) => setTimeout(r, 1000));
const seen = recentRequests();
check(`the request log names the swap (${JSON.stringify(seen.slice(0, 3)).slice(0, 300)})`, seen.some((r) => r.host === 'httpbin.org' && r.swapped.includes(secret.id)));
const cron = spawnSync('crontab', ['-l', '-u', 'agent'], { encoding: 'utf8' }).stdout;
check("the agent's cron jobs get the proxy settings", cron.includes('HTTPS_PROXY=http://127.0.0.1:8421') && cron.includes('HTTPBIN_TOKEN=HTTPBIN_TOKEN'));
setVaultEnabled(false);
const off = await applyVault(u);
check('the vault turns off', !off.status.enabled && Object.keys(agentExtraEnv()).length === 0);
await new Promise((r) => setTimeout(r, 500));
check('and the agent reaches the internet directly again', asAgentOut("/usr/bin/curl -s -m 20 -o /dev/null --noproxy '*' https://httpbin.org/get").ok);
check('and its cron jobs lose the settings', !spawnSync('crontab', ['-l', '-u', 'agent'], { encoding: 'utf8' }).stdout.includes('HTTPS_PROXY'));
stopProxy();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
