// Local-test harness for the telegram-user station.
//
// Boots a fully ISOLATED metro daemon that runs ONLY the telegram-user train,
// reading the maintainer's own creds from packages/telegram-user/.env.local.
// It never reads or writes the real ~/.metro (prod XMTP/MLS state) because it
// overrides HOME + every metro state/config/trains dir to a throwaway path
// under <repo>/.dev-telegram-user, and binds the webhook server to a
// non-default port. Run with:
//
//   bun packages/telegram-user/scripts/dev-local.ts
//
// See packages/telegram-user/README.md → "Local testing" for the full runbook.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = (s: string): void => void process.stdout.write(s);

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(pkgDir, '..', '..');

const WEBHOOK_PORT = process.env.METRO_WEBHOOK_PORT ?? '8430';

// Isolated, throwaway roots — never the real ~/.metro / ~/.cache/metro.
const devRoot = join(pkgDir, '.dev-telegram-user');
const stateDir = join(devRoot, 'state');
const trainsDir = join(devRoot, 'trains');
const configDir = join(devRoot, 'config');
const fakeHome = join(devRoot, 'home');

// ---- load creds from .env.local --------------------------------------------

const ENV_FILE = join(pkgDir, '.env.local');

const LINE_RE = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/;
const QUOTED_RE = /^(['"])(.*)\1$/;

function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined)
      env[m[1]] = m[2].replace(QUOTED_RE, '$2');
  }
  return env;
}

const dotenv = readDotenv(ENV_FILE);
const pick = (key: string): string | undefined =>
  process.env[key] ?? (dotenv[key] || undefined);

const apiId = pick('TELEGRAM_USER_API_ID');
const apiHash = pick('TELEGRAM_USER_API_HASH');
const session = pick('TELEGRAM_USER_SESSION');
const onlyAccounts = pick('TELEGRAM_USER_ONLY_ACCOUNTS');

if (!apiId || !apiHash || !session) {
  out(
    [
      '',
      'telegram-user local harness: missing credentials.',
      '',
      `Set packages/telegram-user/.env.local with:`,
      '  TELEGRAM_USER_API_ID=<api id from my.telegram.org>',
      '  TELEGRAM_USER_API_HASH=<api hash from my.telegram.org>',
      '  TELEGRAM_USER_SESSION=<session string>',
      '',
      'Run scripts/login.ts to get the session:',
      '  bun packages/telegram-user/scripts/login.ts',
      '',
      '(copy packages/telegram-user/.env.local.example to .env.local to start)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// ---- build the isolated environment ----------------------------------------

for (const dir of [stateDir, trainsDir, configDir, fakeHome]) {
  mkdirSync(dir, { recursive: true });
}

// Single train stub: only the telegram-user train is discovered + spawned.
writeFileSync(
  join(trainsDir, 'telegram-user.ts'),
  "import '@metro-labs/telegram-user/train';\n",
);

const childEnv: Record<string, string> = {
  ...process.env,
  // Isolation: every path the daemon + train touch points at the throwaway root.
  HOME: fakeHome,
  METRO_STATE_DIR: stateDir,
  METRO_TRAINS_DIR: trainsDir,
  METRO_CONFIG_DIR: configDir,
  METRO_WEBHOOK_PORT: WEBHOOK_PORT,
  // Pin a local self-identity so boot never shells out to `claude auth status`
  // (which would fail under the overridden HOME). This is a local test daemon.
  METRO_FROM: process.env.METRO_FROM ?? 'metro://user',
  // telegram-user creds (single-account fast path).
  TELEGRAM_USER_API_ID: apiId,
  TELEGRAM_USER_API_HASH: apiHash,
  TELEGRAM_USER_SESSION: session,
  // Clear sibling-station creds so only telegram-user is live.
  MNEMONIC: '',
  TELEGRAM_BOT_TOKENS: '',
  DISCORD_BOT_TOKENS: '',
  // Default to verbose so inbound events + auth errors are visible.
  METRO_LOG_LEVEL: process.env.METRO_LOG_LEVEL ?? 'debug',
};
if (onlyAccounts) childEnv.TELEGRAM_USER_ONLY_ACCOUNTS = onlyAccounts;
// Don't impersonate a Claude Code session: with CLAUDECODE set, boot derives the
// self-identity by shelling out to `claude auth status`, which fails under the
// overridden HOME. METRO_FROM already pins a static self for this local daemon.
delete childEnv.CLAUDECODE;
// Drop any real telegram-user accounts file path; keep within the fake HOME.
delete childEnv.TELEGRAM_USER_ACCOUNTS;
delete childEnv.TELEGRAM_USER_ACCOUNTS_FILE;

out(
  [
    '',
    'telegram-user local harness booting an isolated metro daemon:',
    `  state dir   : ${stateDir}`,
    `  trains dir  : ${trainsDir}`,
    `  config dir  : ${configDir}`,
    `  fake HOME   : ${fakeHome}`,
    `  webhook port: ${WEBHOOK_PORT}`,
    '  station     : telegram-user (only)',
    '',
    'Watching for inbound Telegram events. Ctrl-C to stop.',
    `Clean up with: rm -rf ${devRoot}`,
    '',
  ].join('\n'),
);

// ---- boot the daemon, streaming its logs to this terminal ------------------

const serverEntry = join(repoRoot, 'apps', 'mcp', 'src', 'server.ts');

const child = spawn('bun', ['run', serverEntry], {
  cwd: devRoot, // so cwd/.env resolves inside the isolated root (empty)
  env: childEnv,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  out(`\nlocal daemon exited (code=${code ?? 'null'} signal=${signal ?? 'null'})\n`);
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
