import type { IncomingMessage } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { CodexAuthError } from './codex-auth.js';
import { GeminiAuthError } from './gemini-auth.js';
import { GatewayError } from './forward.js';
import { lastServed } from './served.js';
import { usageSeen } from './usage.js';
import { ModelConfigError, connectionOf, publicModelConfig, routedConnection, type Connection, type ModelConfig, type Provider } from './model-config.js';
import type { SetupDeps } from '../claude/setup.js';

export interface ModelApiDeps {
  authorize: (subject: string) => void;
  read?: () => ModelConfig;
  write?: (cfg: ModelConfig) => void;
  issuer?: string;
  fetchImpl?: typeof fetch;
  codexHome?: string;
  codexBase?: string;
  geminiAuthBase?: string;
  geminiTokenBase?: string;
  geminiUserBase?: string;
  geminiBase?: string;
  openrouterBase?: string;
  anthropicBase?: string;
  bedrockControlBase?: string;
  setup?: SetupDeps;
}

export interface Store {
  read: () => ModelConfig;
  write: (cfg: ModelConfig) => void;
}

export type Handler = (req: IncomingMessage, deps: ModelApiDeps, store: Store) => Promise<unknown>;

export interface Route {
  method: 'GET' | 'POST';
  run: Handler;
}

export const BODY_MAX = 16 * 1024;
export const CREDITS_TTL_MS = 5 * 60_000;

export const settingsBody = (cfg: ModelConfig): Record<string, unknown> => ({
  ...publicModelConfig(cfg),
  lastServed: lastServed(),
  usage: usageSeen(),
});

export function asApiError(err: unknown): never {
  if (err instanceof ModelConfigError || err instanceof CodexAuthError || err instanceof GeminiAuthError) throw new ApiError(err.message, 400);
  if (err instanceof GatewayError) throw new ApiError(err.message, err.status >= 400 && err.status < 500 ? 400 : 502);
  throw err;
}

export const askedConnection = (req: IncomingMessage): string => new URL(req.url ?? '', 'http://metro').searchParams.get('connection') ?? '';

export function connectionFor(cfg: ModelConfig, req: IncomingMessage, provider: Provider): Connection {
  const asked = askedConnection(req);
  if (asked !== '') {
    const found = connectionOf(cfg, asked);
    if (found?.provider !== provider) throw new ApiError('no such connection', 404);
    return found;
  }
  const routed = routedConnection(cfg);
  if (routed?.provider === provider) return routed;
  const first = cfg.connections.find((c) => c.provider === provider);
  if (first === undefined) throw new ApiError(`no ${provider} connection yet`, 400);
  return first;
}
