export const PROVIDERS = ['anthropic', 'bedrock', 'openrouter', 'codex', 'routeway'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type CodexMethod = 'chatgpt' | 'code';
export type RouteSource = 'agent' | 'organization';

export interface CodexAccess {
  method: CodexMethod;
  accessToken: string;
  expiresAt: number;
  accountId: string | null;
}

export interface Account {
  email: string | null;
  plan: string | null;
  method: CodexMethod | null;
}

export interface Connection {
  id: string;
  provider: Provider;
  label: string;
  model: string;
  apiKey: string;
  region: string;
  zdr: boolean;
  revision: number;
  codex: CodexAccess | null;
  claudeToken: string;
  account: Account;
  signedOut: boolean;
}

export interface Fallback {
  connection: string;
  model: string;
}

export interface ModelSetup {
  primary: Fallback | null;
  fallbacks: Fallback[];
  connections: Connection[];
  source: RouteSource | null;
}

export interface Route {
  connection: Connection;
  model: string;
}

export const CODEX_SIGN_IN = "Codex is not signed in: sign in again on the organization's Models page.";

const PREFIX_RE = /^(anthropic|bedrock|openrouter|codex|routeway):(.+)$/;
const SMALL_RE = /haiku/i;

export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);

export const emptySetup = (): ModelSetup => ({ primary: null, fallbacks: [], connections: [], source: null });

export const connectionOf = (setup: ModelSetup, id: string): Connection | null => setup.connections.find((c) => c.id === id) ?? null;

export function primaryRoute(setup: ModelSetup): Route | null {
  const steps = setup.primary === null ? [] : [setup.primary, ...setup.fallbacks];
  for (const step of steps) {
    const conn = connectionOf(setup, step.connection);
    if (conn !== null) return { connection: conn, model: step.model === '' ? conn.model : step.model };
  }
  return null;
}

const CHECKS: Record<Provider, [(r: Route) => boolean, string][]> = {
  anthropic: [[(r) => r.connection.apiKey === '' && r.connection.claudeToken === '', "Anthropic has no API key or Claude subscription: add one on the organization's Models page."]],
  bedrock: [
    [(r) => r.connection.apiKey === '', "Bedrock has no API key: add it on the organization's Models page."],
    [(r) => r.connection.region === '', "Bedrock needs a region: add it on the organization's Models page."],
  ],
  openrouter: [
    [(r) => r.connection.apiKey === '', "OpenRouter has no API key: add it on the organization's Models page."],
    [(r) => r.model === '', "OpenRouter needs a model id: choose one on the organization's Models page."],
  ],
  codex: [
    [(r) => r.connection.codex === null, CODEX_SIGN_IN],
    [(r) => r.model === '', "Codex needs a model id: choose one on the organization's Models page."],
  ],
  routeway: [
    [(r) => r.connection.apiKey === '', "Routeway has no API key: add it on the organization's Models page."],
    [(r) => r.model === '', "Routeway needs a model id: choose one on the organization's Models page."],
  ],
};

export const notReady = (route: Route): string | null => CHECKS[route.connection.provider].find(([missing]) => missing(route))?.[1] ?? null;

export const isSmallModel = (requested: string): boolean => SMALL_RE.test(requested);

const DEFAULTS: Record<Provider, (requested: string, model: string) => string> = {
  openrouter: (requested, model) => (requested.includes('/') ? requested : model),
  bedrock: (requested, model) => (model === '' ? requested : model),
  codex: (requested, model) => (requested.startsWith('gpt-') ? requested : model),
  routeway: (_requested, model) => model,
  anthropic: (requested, model) => (model === '' || isSmallModel(requested) ? requested : model),
};

function forProvider(setup: ModelSetup, provider: Provider): Connection | null {
  const routed = primaryRoute(setup)?.connection ?? null;
  if (routed?.provider === provider) return routed;
  return setup.connections.find((c) => c.provider === provider) ?? null;
}

export const bareModel = (requested: string): string => PREFIX_RE.exec(requested)?.[2]?.trim() ?? requested;

export function resolveRoute(requested: string, setup: ModelSetup): Route | null {
  const explicit = PREFIX_RE.exec(requested);
  if (explicit !== null && isProvider(explicit[1])) {
    const conn = forProvider(setup, explicit[1]);
    if (conn !== null) return { connection: conn, model: (explicit[2] ?? '').trim() };
  }
  const primary = primaryRoute(setup);
  if (primary === null) return null;
  return { connection: primary.connection, model: DEFAULTS[primary.connection.provider](bareModel(requested), primary.model) };
}

export const routeLabel = (route: Route): string =>
  route.connection.provider === 'anthropic' ? route.model : `${route.connection.provider}:${route.model}`;

export function runnerModel(setup: ModelSetup): string | null {
  const primary = primaryRoute(setup);
  return primary === null || primary.model === '' ? null : routeLabel(primary);
}
