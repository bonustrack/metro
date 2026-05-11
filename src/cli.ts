#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import * as discord from './channels/discord.js';
import * as telegram from './channels/telegram.js';
import { readDotenv, writeDotenv } from './lib/dotenv.js';
import { errMsg } from './log.js';
import { CONFIG_ENV_FILE, configuredPlatforms, loadMetroEnv, STATE_DIR } from './paths.js';

const USAGE = `metro — Telegram + Discord bridge for your Claude Code / Codex agent

Usage:
  metro                                       Run the orchestrator daemon.
                                              Each chat conversation gets its own
                                              codex session, with streaming responses.
  metro setup                                 Show config status (tokens).
  metro setup telegram <token>                Save TELEGRAM_BOT_TOKEN (validated via getMe).
  metro setup discord <token>                 Save DISCORD_BOT_TOKEN (validated via getMe).
  metro setup clear [telegram|discord|all]    Remove tokens.
  metro doctor                                Health check: tokens + gateway reachability.
  metro update                                Upgrade in place (npm/bun/pnpm auto-detected).
  metro --version, -v                         Print version.
  metro --help, -h                            This help.

Exit codes:
  0 success · 1 usage · 2 config (no tokens — run \`metro setup\`) · 3 upstream
`;

type Flags = Record<string, string | boolean>;
type ExitErr = Error & { code?: number };

function exitErr(msg: string, code: number): ExitErr { return Object.assign(new Error(msg), { code }); }

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
  }
  return { positional, flags };
}

const isJson = (f: Flags): boolean => f.json === true;
const emitResult = (f: Flags, human: string, structured: unknown): void => {
  process.stdout.write(isJson(f) ? JSON.stringify(structured) + '\n' : human + '\n');
};
function maskToken(t: string): string {
  if (!t) return '';
  if (t.length <= 8) return '••••';
  return `${t.slice(0, 6)}…${t.slice(-2)}`;
}

const TOKEN_KEYS = { telegram: 'TELEGRAM_BOT_TOKEN', discord: 'DISCORD_BOT_TOKEN' } as const;

async function cmdSetup(positional: string[], flags: Flags): Promise<void> {
  const [sub, value] = positional;
  if (!sub) return cmdSetupStatus(flags);

  if (sub === 'telegram' || sub === 'discord') {
    if (!value) throw new Error(`metro setup ${sub} <token> — token is required`);
    const trimmed = value.trim();
    let identity: string | undefined;
    if (!flags['no-validate']) {
      process.env[TOKEN_KEYS[sub]] = trimmed;
      try {
        identity = sub === 'telegram' ? `@${(await telegram.getMe()).username}` : (await discord.getMe()).username;
      } catch (err) {
        delete process.env[TOKEN_KEYS[sub]];
        throw exitErr(`token rejected by ${sub}: ${errMsg(err)} (use --no-validate to save anyway)`, 3);
      }
    }
    const env = readDotenv(CONFIG_ENV_FILE);
    env[TOKEN_KEYS[sub]] = trimmed;
    writeDotenv(CONFIG_ENV_FILE, env);
    const human = identity
      ? `saved ${TOKEN_KEYS[sub]} (verified as ${identity}) to ${CONFIG_ENV_FILE} (chmod 0600)`
      : `saved ${TOKEN_KEYS[sub]} to ${CONFIG_ENV_FILE} (chmod 0600)`;
    emitResult(flags, human, { ok: true, saved: TOKEN_KEYS[sub], verified_as: identity ?? null });
    return;
  }

  if (sub === 'clear') {
    const target = value ?? 'all';
    const env = readDotenv(CONFIG_ENV_FILE);
    if (target === 'all') { delete env.TELEGRAM_BOT_TOKEN; delete env.DISCORD_BOT_TOKEN; }
    else if (target === 'telegram' || target === 'discord') delete env[TOKEN_KEYS[target]];
    else throw new Error(`metro setup clear <telegram|discord|all> — got '${target}'`);
    writeDotenv(CONFIG_ENV_FILE, env);
    emitResult(flags, `cleared ${target === 'all' ? 'all metro tokens' : TOKEN_KEYS[target as 'telegram' | 'discord']}`, { ok: true, cleared: target });
    return;
  }

  throw new Error(`unknown setup subcommand '${sub}' (try: telegram, discord, clear)`);
}

async function cmdSetupStatus(flags: Flags): Promise<void> {
  loadMetroEnv();
  const tg = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const dc = process.env.DISCORD_BOT_TOKEN ?? '';
  if (isJson(flags)) {
    process.stdout.write(JSON.stringify({
      version: pkg.version,
      config_env_file: CONFIG_ENV_FILE,
      tokens: {
        telegram: { set: !!tg, masked: maskToken(tg) },
        discord: { set: !!dc, masked: maskToken(dc) },
      },
    }) + '\n');
    return;
  }
  process.stdout.write(
    `metro ${pkg.version}\n\n` +
      `config:  ${CONFIG_ENV_FILE}${existsSync(CONFIG_ENV_FILE) ? '' : ' (not yet written)'}\n\n` +
      `  TELEGRAM_BOT_TOKEN  ${tg ? `set (${maskToken(tg)})` : 'not set'}\n` +
      `  DISCORD_BOT_TOKEN   ${dc ? `set (${maskToken(dc)})` : 'not set'}\n\n`,
  );
  if (!tg && !dc) {
    process.stdout.write(
      'Get started:\n' +
        '  1. metro setup telegram <token>    # https://t.me/BotFather\n' +
        '     metro setup discord <token>     # https://discord.com/developers/applications\n' +
        '  2. metro doctor                    # verify\n' +
        '  3. metro                           # run the orchestrator\n',
    );
  } else {
    process.stdout.write('Run `metro` to start the orchestrator, or `metro doctor` to verify.\n');
  }
}

type DoctorCheck = { name: string; ok: boolean | null; detail: string };

async function cmdDoctor(flags: Flags): Promise<void> {
  loadMetroEnv();
  const checks: DoctorCheck[] = [];
  const cfg = configuredPlatforms();

  checks.push({
    name: 'tokens',
    ok: cfg.telegram || cfg.discord,
    detail: cfg.telegram || cfg.discord
      ? `loaded from ${existsSync(CONFIG_ENV_FILE) ? CONFIG_ENV_FILE : 'process env'}`
      : 'no platform configured — run `metro setup telegram|discord <token>`',
  });

  for (const [platform, getMe] of [['telegram', telegram.getMe], ['discord', discord.getMe]] as const) {
    if (!cfg[platform]) {
      checks.push({ name: platform, ok: null, detail: 'not configured' });
      continue;
    }
    try {
      const me = await getMe();
      checks.push({ name: platform, ok: true, detail: `getMe → ${platform === 'telegram' ? '@' : ''}${me.username}` });
    } catch (err) {
      checks.push({ name: platform, ok: false, detail: errMsg(err) });
    }
  }

  const lockFile = join(STATE_DIR, '.tail-lock');
  if (!existsSync(lockFile)) {
    checks.push({ name: 'orchestrator', ok: null, detail: 'not running' });
  } else {
    try {
      const pid = Number(readFileSync(lockFile, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
      process.kill(pid, 0);
      checks.push({ name: 'orchestrator', ok: true, detail: `running (pid ${pid})` });
    } catch {
      checks.push({ name: 'orchestrator', ok: null, detail: 'stale lockfile (will auto-reclaim on next start)' });
    }
  }

  if (isJson(flags)) {
    process.stdout.write(JSON.stringify({ checks }) + '\n');
  } else {
    process.stdout.write('metro doctor\n\n');
    for (const c of checks) {
      const icon = c.ok === true ? '✓' : c.ok === false ? '✗' : '–';
      process.stdout.write(`  ${icon} ${c.name.padEnd(15)} ${c.detail}\n`);
    }
    process.stdout.write('\n');
  }
  if (checks.some(c => c.ok === false)) throw exitErr('one or more checks failed', 3);
}

async function cmdUpdate(flags: Flags): Promise<void> {
  const tag = pkg.version.includes('-') ? 'beta' : 'latest';
  const res = await fetch('https://registry.npmjs.org/@stage-labs/metro', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm registry: ${res.status}`);
  const data = (await res.json()) as { 'dist-tags'?: Record<string, string> };
  const latest = data['dist-tags']?.[tag];
  if (!latest) throw new Error(`no '${tag}' dist-tag for @stage-labs/metro`);
  if (latest === pkg.version) {
    emitResult(flags, `already on ${pkg.version} (latest ${tag})`, { ok: true, current: pkg.version, latest, upgraded: false });
    return;
  }
  const argv1 = process.argv[1] ?? '';
  const spec = `@stage-labs/metro@${tag}`;
  const argv = argv1.includes('/.bun/') || argv1.includes('\\bun\\') ? ['bun', 'add', '-g', spec]
    : argv1.includes('/pnpm/') || argv1.includes('\\pnpm\\') ? ['pnpm', 'add', '-g', spec]
    : ['npm', 'install', '-g', spec];
  if (isJson(flags)) {
    process.stdout.write(JSON.stringify({ ok: true, current: pkg.version, latest, command: argv.join(' ') }) + '\n');
  } else {
    process.stdout.write(`metro ${pkg.version} → ${latest}\n$ ${argv.join(' ')}\n`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: isJson(flags) ? 'ignore' : 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${argv[0]} exited ${code}`))));
    child.on('error', reject);
  });
}

const COMMANDS: Record<string, (positional: string[], flags: Flags) => Promise<void>> = {
  setup: cmdSetup,
  doctor: (_, f) => cmdDoctor(f),
  update: (_, f) => cmdUpdate(f),
};

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(`${pkg.version}\n`); return; }
  if (cmd === '--help' || cmd === '-h') { process.stdout.write(USAGE); return; }

  // Bare `metro` runs the orchestrator (the daemon's the default).
  if (!cmd) { await import('./orchestrator.js'); return; }

  const handler = COMMANDS[cmd];
  if (!handler) {
    process.stderr.write(`unknown command '${cmd}'\n\n${USAGE}`);
    process.exit(1);
  }
  const { positional, flags } = parseArgs(process.argv.slice(3));
  try {
    await handler(positional, flags);
  } catch (err) {
    const code = (err as ExitErr).code;
    if (isJson(flags)) {
      process.stdout.write(JSON.stringify({ ok: false, error: errMsg(err), code: code ?? 1 }) + '\n');
    } else {
      process.stderr.write(`error: ${errMsg(err)}\n`);
    }
    process.exit(typeof code === 'number' ? code : 1);
  }
}

await main();
