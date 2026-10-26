import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { beginOrgOpenRouterLogin } from '@metro-labs/client/api/org-models';
import { afterModelChange, useOrgModelsQuery } from '../lib/model-queries.js';
import { queryError } from '../lib/queries.js';
import { useSignInTab } from './sign-in-tab.js';
import { SignInLink } from './ProviderSignIn.js';
import { TextLink } from './TextLink.js';

const AGAIN = 'Signing in again replaces the key of this connection. The model order stays.';
const WAITING = 'Waiting for OpenRouter. Approve Metro in the tab that opened, then come back here.';

function useNewConnection(waiting: boolean, known: Set<string>, onFound: () => void): void {
  const { data } = useOrgModelsQuery(waiting);
  const found = waiting && data !== undefined && data.connections.some((c) => c.provider === 'openrouter' && !known.has(c.id));
  const latest = useRef(onFound);
  useEffect(() => {
    latest.current = onFound;
  });
  useEffect(() => {
    if (found) latest.current();
  }, [found]);
}

function LoginFlow({ connection, onDone, onManual }: { connection: ConnectionRow | null; onDone: () => void; onManual: () => void }): ReactNode {
  const client = useQueryClient();
  const { data } = useOrgModelsQuery();
  const [known, setKnown] = useState(new Set<string>());
  const [finishing, setFinishing] = useState(false);
  const begin = (): Promise<string> => {
    setKnown(new Set(data?.connections.map((c) => c.id) ?? []));
    return beginOrgOpenRouterLogin(connection?.id ?? '');
  };
  const { starting, started, link, error, start, settle } = useSignInTab(begin, (url) => url, 'Could not start the OpenRouter sign-in.');
  const finish = (): void => {
    setFinishing(true);
    afterModelChange(client)
      .then(() => {
        settle(null);
        onDone();
      })
      .catch((err: unknown) => { settle(queryError(err, 'Could not check the sign-in.')); })
      .finally(() => { setFinishing(false); });
  };
  useNewConnection(started !== null && connection === null, known, finish);
  return (
    <Column gap={10}>
      <SignInLink link={started === null ? null : link} label="Open the OpenRouter sign-in">
        <Button variant="primary" size="lg" label="Continue with OpenRouter" loading={starting} disabled={starting || started !== null} onPress={start} />
      </SignInLink>
      <Text size="md" color="secondary">Authorize Metro in your browser. OpenRouter makes a key for your organization.</Text>
      {connection === null ? null : <Text size="md" color="secondary">{AGAIN}</Text>}
      {started === null ? null : (
        <Column gap={8}>
          <Text size="md" color="secondary">{WAITING}</Text>
          <Row gap={8} wrap>
            <Button variant="primary" size="md" label="I approved it" loading={finishing} disabled={finishing} onPress={finish} />
            <Button size="md" color="secondary" label="Cancel" disabled={finishing} onPress={() => { settle(null); }} />
          </Row>
        </Column>
      )}
      {error === null ? null : <Text size="md" color="danger">{error}</Text>}
      {starting || started !== null ? null : <TextLink size="md" onPress={onManual}>Use an API key</TextLink>}
    </Column>
  );
}

export function OpenRouterConnect({ connection, onDone, children }: { connection: ConnectionRow | null; onDone: () => void; children: ReactNode }): ReactNode {
  const [manual, setManual] = useState(false);
  if (manual) return <Column gap={16}>{children}<TextLink size="md" onPress={() => { setManual(false); }}>Sign in instead</TextLink></Column>;
  return <LoginFlow connection={connection} onDone={onDone} onManual={() => { setManual(true); }} />;
}
