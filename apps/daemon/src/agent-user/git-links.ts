import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { errMsg, log } from '@metro-labs/core/log';
import { asUser, type AgentUser } from './user.js';

const REPAIR = [
  'from="$1"; to="$2"',
  'find "$to" -maxdepth 8 -name node_modules -prune -o -name .git -type f -print 2>/dev/null | while read -r f; do',
  '  grep -q "^gitdir: $from/" "$f" && sed -i "s#^gitdir: $from/#gitdir: $to/#" "$f" && echo "$f"',
  'done',
  'find "$to" -maxdepth 10 -name node_modules -prune -o -path "*/.git/worktrees/*/gitdir" -type f -print 2>/dev/null | while read -r g; do',
  '  grep -q "^$from/" "$g" && sed -i "s#^$from/#$to/#" "$g" && echo "$g"',
  'done',
].join('\n');

export function repairGitLinks(user: AgentUser, from = homedir()): Promise<number> {
  const [file, args] = asUser(user, 'sh', ['-c', REPAIR, 'metro', from, user.home]);
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      log.warn({ err: errMsg(err) }, 'agent-user: could not repair git links');
      resolve(0);
    });
    child.on('close', () => {
      const fixed = out.split('\n').filter((line) => line !== '').length;
      if (fixed > 0) log.info({ fixed }, "agent-user: repaired git links that still pointed into root's home");
      resolve(fixed);
    });
  });
}
