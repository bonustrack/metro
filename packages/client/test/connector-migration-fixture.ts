import { clearAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { createConnectorMigration, type ConnectorMigration } from '../src/api/connector-migration-flow.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { installTestAccount, TEST_ORGANIZATION } from './account-fixture.js';

export const AGENT = 'source00001';
export const SOURCE = 'conn0000001';
export const SCOPE = 'a'.repeat(64);
export const LOCAL = 'https://source.example/api/connectors';
export const CENTRAL = 'https://api.metro.box/api/connectors';
export const sourceRow = () => ({ id: SOURCE, name: 'Calendar', auth: 'oauth', origin: 'https://calendar.example', policy: { read: 'ask', write: 'deny', tools: { edit: 'ask' } }, policySupported: true, issues: ['oauth_sign_in'] });
export const previewBody = () => ({ enabled: true, enrolled: true, agentId: AGENT, owner: TEST_ORGANIZATION, liveEnabled: false, migrationSupported: true, oauthResourceSupported: true, connectors: [sourceRow()] });
export const migrationRow = (phase = 'prepared', reason: string | null = null) => ({ id: 'migration01', sourceId: SOURCE, destinationId: 'central0001', name: 'Calendar', phase, auth: 'oauth', reason, uncertainty: reason === 'requests_uncertain' ? 'b'.repeat(64) : null });
export const statusBody = (migrations: unknown[] = []) => ({ enabled: true, enrolled: true, agentId: AGENT, owner: TEST_ORGANIZATION, scope: SCOPE, migrations });

export function migrationFixture() {
  const originalFetch = globalThis.fetch;
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue(), apiBase: 'https://api.metro.box' });
  installTestAccount();
  setCurrentServer({ id: AGENT, host: 'source.example' });
  const fixture = {
    preview: previewBody() as unknown,
    status: statusBody() as unknown,
    previewCode: 200,
    statusCode: 200,
    postCode: 200,
    reply: statusBody([migrationRow()]) as unknown,
    failPost: false,
    failStatus: false,
    afterFetch: (() => undefined) as (url: string, init: RequestInit) => void,
    requests: [] as Array<{ url: string; init: RequestInit }>,
  };
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    fixture.requests.push({ url, init });
    fixture.afterFetch(url, init);
    if (url === `${LOCAL}/migration-preview`) return Response.json(fixture.preview, { status: fixture.previewCode });
    if (url === CENTRAL) return Response.json({ admin: true, connectors: [] });
    if (url === `${CENTRAL}/central0001/sign-in`) return Response.json({ authorizeUrl: 'https://calendar.example/authorize' });
    if (url !== `${LOCAL}/migrations`) throw new Error('Unexpected fixture request');
    const saving = init.method === 'POST';
    if ((saving && fixture.failPost) || (!saving && fixture.failStatus)) throw new Error('fixture-private-token-in-error');
    return Response.json(saving ? fixture.reply : fixture.status, { status: saving ? fixture.postCode : fixture.statusCode });
  }, { preconnect: originalFetch.preconnect });
  const sessions: ConnectorMigration[] = [];
  return Object.assign(fixture, {
    open: (onInvalidate?: () => void): ConnectorMigration => {
      const session = createConnectorMigration(onInvalidate);
      sessions.push(session);
      return session;
    },
    close: (): void => {
      for (const session of sessions) session.dispose();
      globalThis.fetch = originalFetch;
      setCurrentServer(null);
      clearAccount();
    },
  });
}
