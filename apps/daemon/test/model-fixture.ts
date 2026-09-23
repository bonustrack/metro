import type { Connection, ModelConfig, Provider } from '../src/gateway/model-config.ts';

export const connectionId = (provider: Provider): string => `cn-${provider}`;

export function makeConnection(provider: Provider, fields: Partial<Connection> = {}): Connection {
  return {
    id: connectionId(provider),
    provider,
    label: provider,
    model: '',
    apiKey: '',
    region: '',
    zdr: false,
    codex: null,
    gemini: null,
    ...fields,
  };
}

export const configOf = (route: Provider, connections: Connection[]): ModelConfig => ({
  version: 2,
  route: connectionId(route),
  connections,
});

export function conn(cfg: ModelConfig, provider: Provider): Connection {
  const found = cfg.connections.find((c) => c.provider === provider);
  if (found === undefined) throw new Error(`no ${provider} connection in this fixture`);
  return found;
}

export function use(cfg: ModelConfig, provider: Provider): void {
  cfg.route = conn(cfg, provider).id;
}

export const jwt = (claims: Record<string, unknown>): string => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
