import { isProvider, type CodexAccess, type Connection, type Fallback, type ModelSetup, type Provider } from '../src/gateway/model-config.ts';

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
    revision: 1,
    codex: null,
    claude: null,
    account: { email: null, plan: null, method: null },
    signedOut: false,
    ...fields,
  };
}

export const codexAccess = (fields: Partial<CodexAccess> = {}): CodexAccess => ({ method: 'chatgpt', accessToken: 'at-1', expiresAt: Date.now() + 3_600_000, accountId: null, ...fields });

export const setupOf = (route: string, connections: Connection[], fallbacks: Fallback[] = []): ModelSetup => ({
  primary: { connection: isProvider(route) ? connectionId(route) : route, model: '' },
  fallbacks,
  connections,
  source: 'organization',
});

export function conn(setup: ModelSetup, provider: Provider): Connection {
  const found = setup.connections.find((c) => c.provider === provider);
  if (found === undefined) throw new Error(`no ${provider} connection in this fixture`);
  return found;
}

export function use(setup: ModelSetup, provider: Provider): void {
  setup.primary = { connection: conn(setup, provider).id, model: '' };
}

export const jwt = (claims: Record<string, unknown>): string => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
