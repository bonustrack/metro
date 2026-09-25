import { spawnSync } from 'node:child_process';
import { agentUser, asAgent } from '../../apps/daemon/src/agent-user/user.ts';
import { readAgentPath } from '../../apps/daemon/src/agent-user/files.ts';
import { convertRootJobs, listSchedules } from '../../apps/daemon/src/agent-user/schedules.ts';
import { runNow } from '../../apps/daemon/src/agent-user/schedule-detail.ts';
import { inSessionScope } from '../../apps/daemon/src/claude/memory.ts';
import { applyFirewall, removeFirewall } from '../../apps/daemon/src/vault/firewall.ts';
import { rootHelper, runningAsMetro } from '../../apps/daemon/src/metro-user/privilege.ts';
import { listClaudeProjects, listClaudeSessions, listMemory, readMemoryFile, readTranscript } from '../../apps/daemon/src/claude/files.ts';
import { listClaudeSkills } from '../../apps/daemon/src/claude/skills.ts';
import { listClaudeSettings } from '../../apps/daemon/src/claude/settings.ts';
import { hasConversation, sessionRunning, startSession, stopSession } from '../../apps/daemon/src/claude/session.ts';
import { provisionAgentUser } from '../../apps/daemon/src/agent-user/provision.ts';

const results: string[] = [];
const check = (what: string, ok: boolean): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};
const out = (file: string, args: string[], input?: string): { ok: boolean; text: string } => {
  const r = spawnSync(file, args, { encoding: 'utf8', input, timeout: 30_000 });
  return { ok: r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

check('the daemon sees itself as the metro user', runningAsMetro());
const u = agentUser();
check('and finds the agent user', u !== null);
if (u === null) {
  console.log(results.join('\n'));
  process.exit(1);
}
check('commands run as the agent through sudo', out(...asAgent('id', ['-un'])).text === 'agent');
check('the metro user cannot read /root', !out('ls', ['/root']).ok);
check("the agent cannot read Metro's folder", !out(...asAgent('ls', ['/var/lib/metro'])).ok);
check('the metro user cannot become root outside the helper', !out('sudo', ['-n', 'id']).ok);
const home = readAgentPath(u, '');
check('Files lists the agent folder', home.kind === 'folder' && home.entries.some((e) => e.name === 'bin'));

const scoped = inSessionScope(asAgent('sleep', ['30']));
const child = spawnSync('sh', ['-c', `${[scoped[0], ...scoped[1]].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')} & sleep 2; ps -o user= -C sleep; systemctl list-units --type=scope --no-legend 'metro-claude-*' | wc -l`], { encoding: 'utf8' });
check(`the session starts as the agent in its own memory scope (${child.stdout.trim().replace(/\n/g, ' ')})`, /agent/.test(child.stdout) && /[1-9]\s*$/.test(child.stdout.trim()));

const before = listSchedules(u).map((j) => `${j.kind}:${j.name}:${j.runsAs}`);
check(`the root timer and cron line show up (${before.join(', ')})`, before.some((b) => b.startsWith('timer:demo:')) && before.some((b) => /^cron-(root|agent):demo\.sh/.test(b)));
const switched = convertRootJobs(u);
check(`they switch to the agent through the helper, here or at Metro's own boot (${String(switched)})`, switched === before.filter((b) => b.endsWith(':root')).length);
const after = listSchedules(u).map((j) => `${j.kind}:${j.name}:${j.runsAs}`);
check(`and now run as the agent (${after.join(', ')})`, after.includes('timer:demo:agent') && after.some((a) => a.startsWith('cron-agent:demo.sh')));
check("root's other cron line stays", rootHelper(['root-crontab']).stdout.includes('@reboot /usr/local/bin/keep') && !rootHelper(['root-crontab']).stdout.includes('demo.sh'));
const timer = listSchedules(u).find((j) => j.kind === 'timer');
if (timer !== undefined) runNow(timer.id, u);
await new Promise((r) => setTimeout(r, 2000));
check('Run now starts the timer job as the agent', out(...asAgent('cat', ['/home/agent/demo.log'])).text.includes('demo-ran'));

check('the helper refuses a drop-in on a unit no timer starts', rootHelper(['dropin-write', 'other.service', '10-metro-agent.conf'], '[Service]\nUser=agent\n').status !== 0);
check('the helper refuses a drop-in that runs as root', rootHelper(['dropin-write', 'demo.service', '10-metro-agent.conf'], '[Service]\nUser=root\n').status !== 0);
check('the helper refuses a privileged ExecStart', rootHelper(['dropin-write', 'demo.service', '10-metro-agent.conf'], '[Service]\nUser=agent\nExecStart=\nExecStart=+/bin/sh -c id\n').status !== 0);
check('the helper refuses a metro unit', rootHelper(['start-job', 'metro.service']).status !== 0);
check('the helper refuses an unknown action', rootHelper(['sh']).status !== 0);

applyFirewall(u.uid);
check('the vault firewall goes on through the helper', !out(...asAgent('curl', ['-s', '-m', '5', '-o', '/dev/null', 'https://example.com'])).ok);
removeFirewall(u.uid);
check('and comes off', out(...asAgent('curl', ['-s', '-m', '15', '-o', '/dev/null', 'https://example.com'])).ok);

const claudeDirOf = '/home/agent/.claude';
check(`provisioning as metro sees Claude installed and opens the home to crossing (${await provisionAgentUser({ METRO_RUNTIME_STORE: '' })})`, out('stat', ['-c', '%a', '/home/agent']).text === '711');
check('Sessions lists the projects', listClaudeProjects(claudeDirOf).some((p) => p.id === '-home-agent'));
check('and a private transcript inside a closed folder', listClaudeSessions('-home-agent', claudeDirOf).some((x) => x.id === '11111111-2222-4333-8444-555555555555'));
const turns = await readTranscript('-home-agent', '11111111-2222-4333-8444-555555555555', 0, 50, claudeDirOf);
check('and reads it', JSON.stringify(turns).includes('hello from a private transcript'));
check('Memory lists a private file in a folder', listMemory('-home-agent', claudeDirOf).files.some((f) => f.name === 'people/less.md'));
check('and reads it', readMemoryFile('-home-agent', 'people/less.md', claudeDirOf).includes('short answers'));
check('Skills lists the agent skill', listClaudeSkills(claudeDirOf).some((k) => k.name === 'demo-skill'));
check('Settings lists the files', Array.isArray(listClaudeSettings(claudeDirOf)));
check('the watcher sees there is a conversation to continue', hasConversation('/home/agent', claudeDirOf));
startSession({ metro: ['sleep', '600'], agents: '/var/lib/metro/.metro/agents', continues: () => false });
await new Promise((r) => setTimeout(r, 1000));
check('the Claude session starts under metro', sessionRunning());
stopSession({ agents: '/var/lib/metro/.metro/agents' });

const winch = asAgent('sh', ['-c', 'trap "stty size" WINCH; stty size; sleep 2; sleep 2']);
const pty = out('python3', ['/repo/scripts/metro-user/winch.py', winch[0], ...winch[1]]);
check(`a terminal resize reaches the agent's program through sudo (${pty.text.replace(/\s+/g, ' ')})`, pty.text.includes('24 80') && pty.text.includes('50 132'));

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
