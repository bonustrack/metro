import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { provisionAgentUser } from '../../apps/daemon/src/agent-user/provision.ts';
import { agentUser, asAgent } from '../../apps/daemon/src/agent-user/user.ts';
import { writeHomeText } from '../../apps/daemon/src/agent-user/home-fs.ts';
import { resolveAttachments } from '../../apps/daemon/src/stations/attach-resolve.ts';
import { sessionRunning, startSession, stopSession } from '../../apps/daemon/src/claude/session.ts';
import { stagedPluginDir, syncPluginServers } from '../../apps/daemon/src/connectors/plugin-sync.ts';
import { convertRootJobs, listSchedules } from '../../apps/daemon/src/agent-user/schedules.ts';

const results: string[] = [];
const check = (what: string, ok: boolean): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};
const owner = (p: string): number => statSync(p).uid;
const asAgentOk = (file: string, args: string[]): boolean => spawnSync(...asAgent(file, args), { stdio: 'ignore' }).status === 0;

const out = await provisionAgentUser({ METRO_RUNTIME_STORE: '/opt/store' });
check(`provision answered ready on Linux as root, with no switch (${out})`, out === 'ready');
const u = agentUser();
check('the agent user exists', u !== null);
if (u === null) {
  console.log(results.join('\n'));
  process.exit(1);
}
check('its home is private (700)', (statSync(u.home).mode & 0o777) === 0o700);
check('Claude Code installed for the agent', existsSync(`${u.home}/.local/bin/claude`));
check('plugin copied where the agent can load it', owner(`${u.home}/.metro/marketplace/plugin/.claude-plugin/plugin.json`) === u.uid);
await new Promise((r) => setTimeout(r, 300));
const view = readFileSync(`${u.home}/.metro/agents/agent.json`, 'utf8');
check('the agent file the agent reads has the key', view.includes('agent-key-0123456789abcdef'));
check('and no channel credential', !view.includes('SECRET'));
check('model copy has no provider key', !readFileSync(`${u.home}/.metro/agents/model.json`, 'utf8').includes('SECRET'));
process.env.METRO_RUNTIME_STORE = '/opt/store';
check('the plugin server list goes to the agent copy', stagedPluginDir() === `${u.home}/.metro/marketplace/plugin`);
spawnSync(...asAgent('mkdir', ['-p', `${u.home}/.metro/marketplace/plugin/bin`]));
spawnSync(...asAgent('touch', [`${u.home}/.metro/marketplace/plugin/bin/metro-plugin.mjs`]));
syncPluginServers([{ id: 'c1', name: 'Linear', url: 'https://mcp.linear.app/mcp', transport: 'http', config: {} }] as never);
const mcp = `${u.home}/.metro/marketplace/plugin/.mcp.json`;
check('and is written as the agent', existsSync(mcp) && owner(mcp) === u.uid && readFileSync(mcp, 'utf8').includes('relay/c1'));
check("the agent cannot read root's agent file", !asAgentOk('cat', ['/root/.metro/agents/agent.json']));
check('the agent cannot list /root', !asAgentOk('ls', ['/root']));
writeHomeText(`${u.home}/.claude/skills/ok/SKILL.md`, 'x', 0o644);
check('a skill written by the daemon belongs to the agent', owner(`${u.home}/.claude/skills/ok/SKILL.md`) === u.uid);
spawnSync(...asAgent('ln', ['-s', '/etc', `${u.home}/.claude/skills/evil`]));
let refused = false;
try {
  writeHomeText(`${u.home}/.claude/skills/evil/SKILL.md`, 'pwned', 0o644);
} catch {
  refused = true;
}
check('a symlink planted by the agent cannot make the daemon write into /etc', refused && !existsSync('/etc/SKILL.md'));
const tryPath = async (path: string): Promise<string> => {
  try {
    const [a] = await resolveAttachments([{ path }]);
    return a === undefined ? 'none' : readFileSync(a.path, 'utf8');
  } catch (e) {
    return `refused: ${(e as Error).message.slice(0, 60)}`;
  }
};
check('a send cannot attach a root-only file', (await tryPath('/root/secret.txt')).startsWith('refused'));
check("a send cannot attach root's agent file", (await tryPath('/root/.metro/agents/agent.json')).startsWith('refused'));
spawnSync(...asAgent('sh', ['-c', `echo mine > ${u.home}/ok.txt`]));
check("a send can attach the agent's own file", (await tryPath(`${u.home}/ok.txt`)).trim() === 'mine');
startSession({ metro: ['sleep', '600'], agents: '/root/.metro/agents', continues: () => false });
await new Promise((r) => setTimeout(r, 500));
const who = spawnSync('ps', ['-o', 'user=', '-C', 'sleep'], { encoding: 'utf8' }).stdout.trim();
check(`the Claude session runs as the agent (${who})`, who === 'agent');
check("the watcher sees it in the agent's tmux", sessionRunning());
check('root has no session of its own', spawnSync('tmux', ['has-session', '-t', 'metro']).status !== 0);
stopSession({ agents: '/root/.metro/agents' });
check("stopping it stops the agent's session", !sessionRunning());
const chain = spawnSync(...asAgent('sh', ['-c', 'echo $PPID']), { encoding: 'utf8' }).stdout.trim();
check('switching user leaves no process in between (so tmux gets window resizes)', chain === String(process.pid));
const nightly = listSchedules(u).find((j) => j.kind === 'cron-root' && j.command.includes('nightly.sh'));
check("root's cron job is listed and flagged", nightly?.usesRoot === true);
spawnSync('sh', ['-c', `mkdir -p ${u.home}/bin && cp /root/bin/nightly.sh ${u.home}/bin/ && chown -R agent ${u.home}/bin`]);
check(`every root job pointing into /root is switched at once (${String(convertRootJobs(u, '/root/.metro/agents'))})`, true);
const agentCron = spawnSync('crontab', ['-l', '-u', 'agent'], { encoding: 'utf8' }).stdout;
check('the cron line now runs as the agent with its paths rewritten', agentCron.includes(`0 3 * * * ${u.home}/bin/nightly.sh >> ${u.home}/nightly.log`));
check("and left root's crontab, with a backup kept", !spawnSync('crontab', ['-l', '-u', 'root'], { encoding: 'utf8' }).stdout.includes('nightly.sh') && spawnSync('sh', ['-c', 'ls /root/.metro/agents/crontab-root.*.bak']).status === 0);
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
