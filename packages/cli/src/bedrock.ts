import { randomBytes } from 'node:crypto';
import { claudeArgs, runClaude } from './claude.js';
import { bedrockConfigFromEnv, startBedrockProxy } from './bedrock-proxy.js';
import { settingsConflicts, settingsFiles } from './claude-settings.js';
import { PROVIDER_FLAGS } from './provider-flags.js';

export { PROVIDER_FLAGS, settingsConflicts, settingsFiles };

const SCRUBBED = [...PROVIDER_FLAGS, 'ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK'];

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
