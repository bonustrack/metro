import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSetupStatus, ensureClaudeSetup, type SetupDeps } from '../src/claude/setup.js';
import { cliPackageDir, hooksDir } from '../src/claude/cli-files.js';
import { withMetroHooks } from '../src/claude/hooks.js';

const CHECKOUT = join(import.meta.dir, '..', '..', '..', 'packages', 'cli');
const OWN_BASH = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
const OWN_STOP = { hooks: [{ type: 'command', command: 'say done', timeout: 5 }] };

let dir = '';

function fakeCli(name: string): string {
  const cli = join(dir, name);
  mkdirSync(join(cli, 'hooks'), { recursive: true });
  for (const file of ['guard.mjs', 'session-start.mjs']) writeFileSync(join(cli, 'hooks', file), '');
  return cli;
}

const guardOf = (cli: string): Record<string, unknown> => ({ type: 'command', command: `node "${join(cli, 'hooks', 'guard.mjs')}"`, statusMessage: 'Checking the orchestrator boundary' });
const startOf = (cli: string): Record<string, unknown> => ({ type: 'command', command: `node "${join(cli, 'hooks', 'session-start.mjs')}"` });
const deps = (cli: string): SetupDeps => ({ dir: join(dir, 'claude'), agents: join(dir, 'agents'), cli });
const settingsPath = (): string => join(dir, 'claude', 'settings.json');
const settings = (): Record<string, unknown> => JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
const hooks = (): Record<string, unknown> => settings().hooks as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-hooks-'));
  mkdirSync(join(dir, 'claude'));
  mkdirSync(join(dir, 'agents'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('metro hooks in Claude Code user settings', () => {
  test('are added next to the owner hooks, which stay as they were, and the next run writes nothing', () => {
    const cli = fakeCli('cli');
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { PreToolUse: [OWN_BASH], Stop: [OWN_STOP] } }));
    expect(ensureClaudeSetup(deps(cli))).toMatchObject({ guard: true, settings: 'written' });
    expect(hooks()).toEqual({
      PreToolUse: [OWN_BASH, { hooks: [guardOf(cli)] }],
      Stop: [OWN_STOP],
      SessionStart: [{ hooks: [startOf(cli)] }],
    });
    const before = readFileSync(settingsPath(), 'utf8');
    const mtime = statSync(settingsPath()).mtimeMs;
    expect(ensureClaudeSetup(deps(cli)).settings).toBe('unchanged');
    expect(readFileSync(settingsPath(), 'utf8')).toBe(before);
    expect(statSync(settingsPath()).mtimeMs).toBe(mtime);
    expect(claudeSetupStatus(deps(cli)).guard).toBe(true);
  });

  test('follow the CLI when it moves: the old entries are replaced where they are, a duplicate goes, the owner hooks stay', () => {
    const old = fakeCli('old');
    const moved = fakeCli('moved');
    ensureClaudeSetup(deps(old));
    const placed = hooks();
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        ...settings(),
        hooks: {
          ...placed,
          PreToolUse: [{ hooks: [{ type: 'command', command: 'echo first' }, guardOf(old)] }, OWN_BASH, { hooks: [guardOf(old)] }],
        },
      }),
    );
    expect(ensureClaudeSetup(deps(moved))).toMatchObject({ guard: true, settings: 'written' });
    expect(hooks()).toEqual({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo first' }, guardOf(moved)] }, OWN_BASH],
      SessionStart: [{ hooks: [startOf(moved)] }],
    });
    expect(JSON.stringify(settings())).not.toContain(join(old, 'hooks'));
  });

  test('hooks in a shape Claude Code does not read are left alone, and the guard is reported missing', () => {
    const cli = fakeCli('cli');
    for (const shape of [[], { PreToolUse: { hooks: [] } }, 'none']) {
      writeFileSync(settingsPath(), JSON.stringify({ hooks: shape }));
      expect(ensureClaudeSetup(deps(cli)).guard).toBe(false);
      expect(settings().hooks).toEqual(shape);
    }
    expect(withMetroHooks({ hooks: [] }, join(cli, 'hooks'))).toBeNull();
  });

  test('are not written when the CLI has no hooks next to it, or its path would need shell quoting', () => {
    expect(hooksDir(join(dir, 'nowhere'))).toBeNull();
    const odd = fakeCli('it"s');
    expect(hooksDir(odd)).toBeNull();
    expect(ensureClaudeSetup(deps(odd)).guard).toBe(false);
    expect(hooksDir(CHECKOUT)).toBe(join(CHECKOUT, 'hooks'));
  });
});

describe('where the CLI package is', () => {
  test('is the package of METRO_CLI_BIN through the npm bin link, else the checkout', () => {
    const pkg = join(dir, 'prefix', 'lib', 'node_modules', '@stage-labs', 'metro');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'cli.js'), '');
    mkdirSync(join(dir, 'prefix', 'bin'), { recursive: true });
    symlinkSync(join('..', 'lib', 'node_modules', '@stage-labs', 'metro', 'dist', 'cli.js'), join(dir, 'prefix', 'bin', 'metro'));
    expect(cliPackageDir({ METRO_CLI_BIN: join(dir, 'prefix', 'bin', 'metro') })).toBe(realpathSync(pkg));
    expect(cliPackageDir({})).toBe(CHECKOUT);
    expect(cliPackageDir({ METRO_CLI_BIN: '/nonexistent' })).toBe(CHECKOUT);
  });
});
