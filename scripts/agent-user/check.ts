import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { provisionAgentUser } from '../../apps/daemon/src/agent-user/provision.ts';
import { agentUser, asAgent } from '../../apps/daemon/src/agent-user/user.ts';
import { writeHomeText } from '../../apps/daemon/src/agent-user/home-fs.ts';
import { resolveAttachments } from '../../apps/daemon/src/stations/attach-resolve.ts';

const results: string[] = [];
const check = (what: string, ok: boolean): void => { results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const owner = (p: string): number => statSync(p).uid;
const asAgentOk = (file: string, args: string[]): boolean => spawnSync(...asAgent(file, args), { stdio: 'ignore' }).status === 0;

const out = await provisionAgentUser('/root/.metro/agents', { METRO_RUNTIME_STORE: '/opt/store' });
check(`provision answered ready (${out})`, out === 'ready');
const u = agentUser('/root/.metro/agents');
check('the agent user exists', u !== null);
if (u === null) { console.log(results.join('\n')); process.exit(1); }
check('its home is private (700)', (statSync(u.home).mode & 0o777) === 0o700);
check('Claude folder moved and owned by the agent', owner(`${u.home}/.claude/.credentials.json`) === u.uid);
check('the project folder follows the new home', existsSync(`${u.home}/.claude/projects/-home-agent/s1.jsonl`));
check('.claude.json moved', owner(`${u.home}/.claude.json`) === u.uid);
check('root keeps its own copy', existsSync('/root/.claude/.credentials.json'));
check('Claude Code installed for the agent', existsSync(`${u.home}/.local/bin/claude`));
check('plugin copied where the agent can load it', owner(`${u.home}/.metro/marketplace/plugin/.claude-plugin/plugin.json`) === u.uid);
await new Promise((r) => setTimeout(r, 300));
const view = readFileSync(`${u.home}/.metro/agents/agent.json`, 'utf8');
check('the agent file the agent reads has the key', view.includes('agent-key-0123456789abcdef'));
check('and no channel credential', !view.includes('SECRET'));
check('model copy has no provider key', !readFileSync(`${u.home}/.metro/agents/model.json`, 'utf8').includes('SECRET'));
check('the agent cannot read root\'s agent file', !asAgentOk('cat', ['/root/.metro/agents/agent.json']));
check('the agent cannot list /root', !asAgentOk('ls', ['/root']));
writeHomeText(`${u.home}/.claude/skills/ok/SKILL.md`, 'x', 0o644);
check('a skill written by the daemon belongs to the agent', owner(`${u.home}/.claude/skills/ok/SKILL.md`) === u.uid);
spawnSync(...asAgent('ln', ['-s', '/etc', `${u.home}/.claude/skills/evil`]));
let refused = false;
try { writeHomeText(`${u.home}/.claude/skills/evil/SKILL.md`, 'pwned', 0o644); } catch { refused = true; }
check('a symlink planted by the agent cannot make the daemon write into /etc', refused && !existsSync('/etc/SKILL.md'));
const tryPath = async (path: string): Promise<string> => {
  try { const [a] = await resolveAttachments([{ path }]); return a === undefined ? 'none' : readFileSync(a.path, 'utf8'); } catch (e) { return `refused: ${(e as Error).message.slice(0, 60)}`; }
};
check('a send cannot attach a root-only file', (await tryPath('/root/secret.txt')).startsWith('refused'));
check('a send cannot attach root\'s agent file', (await tryPath('/root/.metro/agents/agent.json')).startsWith('refused'));
spawnSync(...asAgent('sh', ['-c', `echo mine > ${u.home}/ok.txt`]));
check('a send can attach the agent\'s own file', (await tryPath(`${u.home}/ok.txt`)).trim() === 'mine');
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
