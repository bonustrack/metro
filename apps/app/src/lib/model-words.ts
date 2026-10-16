import { usesKey, type ConnectionRow } from '@metro-labs/client/api/model';
import { providerLabel } from '@metro-labs/client/api/providers';
import { routeSteps, type ModelRoute } from '@metro-labs/client/api/model-route';

export const DEFAULT_MODEL_WORD = 'Default model';

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;

export function routeSummary(route: ModelRoute | null): string {
  if (route === null) return 'No model yet';
  const model = route.primary.model === '' ? DEFAULT_MODEL_WORD : route.primary.model;
  const backups = route.fallbacks.length;
  return backups === 0 ? model : `${model}, then ${plural(backups, 'backup', 'backups')}`;
}

export function agentsWord(count: number): string {
  return count === 0 ? 'No agent' : plural(count, 'agent', 'agents');
}

export function namesLine(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

export interface AccountLine {
  text: string;
  bad: boolean;
}

function signedOutLine(connection: ConnectionRow): string {
  return usesKey(connection.provider) && !connection.subscription ? 'No key yet' : 'Signed out';
}

function keyExtras(connection: ConnectionRow): string[] {
  if (connection.provider === 'bedrock') return connection.region === '' ? [] : [connection.region];
  return connection.provider === 'openrouter' && connection.zdr ? ['Zero data retention'] : [];
}

export function accountLine(connection: ConnectionRow): AccountLine {
  if (connection.signedOut) return { text: signedOutLine(connection), bad: true };
  if (connection.subscription || connection.provider === 'codex') return { text: [connection.account ?? 'Signed in', connection.plan ?? ''].filter((part) => part !== '').join(' · '), bad: false };
  return { text: ['Key saved', ...keyExtras(connection)].join(' · '), bad: false };
}

export function accountKind(connection: ConnectionRow): string {
  if (connection.subscription) return 'Claude subscription';
  if (connection.provider === 'codex') return 'ChatGPT';
  if (connection.provider === 'anthropic') return 'Anthropic key';
  return providerLabel(connection.provider);
}

export const usesConnection = (route: ModelRoute | null, id: string): boolean => routeSteps(route).some((step) => step.connection === id);

export function signInTitle(connection: ConnectionRow): { title: string; subtitle: string } {
  if (connection.subscription) return { title: 'Paste a new token', subtitle: 'A new Claude subscription token, or another account' };
  if (connection.provider === 'codex') return { title: connection.signedOut ? 'Sign in' : 'Sign in again', subtitle: 'Another ChatGPT account, or renew access' };
  return { title: connection.signedOut ? 'Add a key' : 'Replace the key', subtitle: connection.provider === 'bedrock' ? 'The key and the AWS region' : 'Paste a new key from the provider' };
}
