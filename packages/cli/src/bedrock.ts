import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeArgs } from './claude.js';
import { bedrockConfigFromEnv, startBedrockProxy } from './bedrock-proxy.js';

export const PROVIDER_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_GATEWAY',
];

const CONFLICTING = [
  ...PROVIDER_FLAGS,
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

const SCRUBBED = [...PROVIDER_FLAGS, 'ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK'];

export function settingsFiles(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim() ?? '';
  const configDir = explicit === '' ? join(homedir(), '.claude') : explicit;
  return [
    ...new Set([
      join(configDir, 'settings.json'),
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json'),
    ]),
  ];
}

function envBlock(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { env?: unknown };
    const block = parsed.env;
    return typeof block === 'object' && block !== null
      ? (block as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function settingsConflicts(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const block = envBlock(file);
    for (const key of CONFLICTING) {
      const value = block[key];
      if (typeof value === 'string' && value.trim() !== '') out.push(`${file}: ${key}`);
    }
  }
  return out;
}

export function firstPartyModelId(bedrockId: string): string {
  return bedrockId.replace(/^(?:[a-z-]+\.)?anthropic\./, '').replace(/-v\d+:\d+$/, '');
}

export function claudeEnv(
  base: NodeJS.ProcessEnv,
  port: number,
  token: string,
  pinned: string | null = null,
): NodeJS.ProcessEnv {
  const kept = Object.entries(base).filter(([key]) => !SCRUBBED.includes(key));
  const model = (base.ANTHROPIC_MODEL ?? '').trim();
  return {
    ...Object.fromEntries(kept),
    ...(pinned !== null && model === '' && { ANTHROPIC_MODEL: firstPartyModelId(pinned) }),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(port)}`,
    ANTHROPIC_AUTH_TOKEN: token,
  };
}

function runClaude(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const leaveToChild = (): undefined => undefined;
    process.on('SIGINT', leaveToChild);
    process.on('SIGTERM', leaveToChild);
    const child = spawn('claude', args, { stdio: 'inherit', env });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? 'the `claude` command is not on PATH — install Claude Code first'
            : err.message,
        ),
      );
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

export async function bedrock(argv: string[]): Promise<number> {
  const cfg = bedrockConfigFromEnv();
  const conflicts = settingsConflicts(settingsFiles());
  if (conflicts.length > 0)
    throw new Error(
      'metro bedrock: these settings would put Claude Code back on a third-party provider, or override the proxy. Remove them, or point CLAUDE_CONFIG_DIR at a separate profile:\n  ' +
        conflicts.join('\n  '),
    );
  const token = `mb_${randomBytes(18).toString('base64url')}`;
  const proxy = await startBedrockProxy(cfg, { token });
  const pinned = cfg.model === null ? '' : ` (${cfg.model})`;
  process.stderr.write(
    `metro bedrock: Claude Code → http://127.0.0.1:${String(proxy.port)} → Bedrock ${cfg.region}${pinned}\n`,
  );
  try {
    return await runClaude(
      claudeArgs(argv),
      claudeEnv(process.env, proxy.port, token, cfg.model),
    );
  } finally {
    await proxy.close();
  }
}
