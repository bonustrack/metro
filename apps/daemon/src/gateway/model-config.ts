export const PROVIDERS = ['anthropic', 'bedrock', 'openrouter', 'codex'] as const;
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
  claude: string | null;
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

export const LOCAL_PREFIX = 'local:';
export const SESSION_LOGIN = `${LOCAL_PREFIX}session`;
export const CODEX_SIGN_IN = "Codex is not signed in: sign in again on the organization's Models page.";

const PREFIX_RE = /^(anthropic|bedrock|openrouter|codex):(.+)$/;
const SMALL_RE = /haiku/i;
const NO_ACCOUNT: Account = { email: null, plan: null, method: null };

export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);

export const emptySetup = (): ModelSetup => ({ primary: null, fallbacks: [], connections: [], source: null });

export const loginRef = (login: string): string => `${LOCAL_PREFIX}${login}`;

const localConnection = (id: string, label: string, claude: string | null, account: Account, missing: boolean): Connection => ({
  id,
  provider: 'anthropic',
  label,
  model: '',
  apiKey: '',
  region: '',
  zdr: false,
  revision: 0,
  codex: null,
  claude,
  account,
  signedOut: missing,
});

export const sessionConnection = (): Connection => localConnection(SESSION_LOGIN, 'Claude Code login', null, NO_ACCOUNT, false);

export interface LocalLogin {
  id: string;
  email: string | null;
  plan: string | null;
}

export function loginConnection(login: string, known: LocalLogin | undefined): Connection {
  const account = known === undefined ? NO_ACCOUNT : { email: known.email, plan: known.plan, method: null };
  return localConnection(loginRef(login), known?.email ?? 'Claude login', login, account, known === undefined);
}

export const connectionOf = (setup: ModelSetup, id: string): Connection | null => setup.connections.find((c) => c.id === id) ?? null;

export function primaryRoute(setup: ModelSetup): Route | null {
  const primary = setup.primary;
  const conn = primary === null ? null : connectionOf(setup, primary.connection);
  if (primary === null || conn === null) return null;
  return { connection: conn, model: primary.model === '' ? conn.model : primary.model };
}

const MISSING_LOGIN = 'This Claude login is not on this box: sign in again on the Model page.';

const CHECKS: Record<Provider, [(r: Route) => boolean, string][]> = {
  anthropic: [
    [(r) => r.connection.claude !== null && r.connection.signedOut, MISSING_LOGIN],
    [(r) => !r.connection.id.startsWith(LOCAL_PREFIX) && r.connection.apiKey === '', "Anthropic has no API key: add it on the organization's Models page."],
  ],
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
};

export const notReady = (route: Route): string | null => CHECKS[route.connection.provider].find(([missing]) => missing(route))?.[1] ?? null;

export const isSmallModel = (requested: string): boolean => SMALL_RE.test(requested);

const DEFAULTS: Record<Provider, (requested: string, model: string) => string> = {
  openrouter: (requested, model) => (requested.includes('/') ? requested : model),
  bedrock: (requested, model) => (model === '' ? requested : model),
  codex: (requested, model) => (requested.startsWith('gpt-') ? requested : model),
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
