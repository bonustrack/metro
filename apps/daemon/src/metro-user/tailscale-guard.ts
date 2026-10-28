import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const TAILSCALED_DEFAULTS = '/etc/default/tailscaled';
const NO_FORWARDING = 'TS_SSH_DISABLE_FORWARDING=1';

type Run = (file: string, args: string[]) => boolean;

const quiet: Run = (file, args) => spawnSync(file, args, { stdio: 'ignore' }).status === 0;

export function withoutForwarding(text: string): string | null {
  if (text.split('\n').some((line) => line.trim() === NO_FORWARDING)) return null;
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${NO_FORWARDING}\n`;
}

export function hardenTailscale(run: Run = quiet, path: string = TAILSCALED_DEFAULTS): string[] {
  if (!run('tailscale', ['version'])) return ['tailscale is not installed here, nothing to harden'];
  const notes: string[] = [];
  const next = withoutForwarding(existsSync(path) ? readFileSync(path, 'utf8') : '');
  if (next !== null) {
    writeFileSync(path, next, { mode: 0o644 });
    notes.push(run('systemctl', ['restart', 'tailscaled']) ? 'Tailscale SSH forwarding is off' : `wrote ${NO_FORWARDING}, but tailscaled did not restart; it applies at its next start`);
  }
  if (!run('tailscale', ['set', '--auto-update'])) notes.push('tailscale set --auto-update failed; update Tailscale by hand');
  return notes;
}
