import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { connectorHost } from '@metro-labs/client/api/connectors';
import { completeOrgConnectorSignIn, signInOrgConnector, takeOrgConnectorReturn, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { BackLink } from './BackLink.js';
import { PageTitle } from './PageTitle.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { Loading } from './Loading.js';
import { OrgConnectorAgents } from './OrgConnectorAgents.js';
import { OrgConnectorAccess, OrgConnectorFacts, OrgConnectorManage } from './OrgConnectorManage.js';
import { OrgConnectorActivity } from './OrgConnectorActivity.js';
import { orgConnectorStatus } from './org-connector-status.js';
import { queryError } from '../lib/queries.js';
import { refreshOrgConnectors, useConnectorScope, useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { useDocumentTitle } from '../lib/title.js';
import { goExternal } from '../lib/open.js';
import { logError } from '../lib/log.js';
import { takeInitialOrgConnectorReturn } from '../lib/location.js';
import { SHRINK } from '../lib/style.js';

const ICON = 32;

interface Outcome {
  busy: boolean;
  note: string | null;
  error: string | null;
}

function useSignInReturn(onDone: () => void): Outcome {
  const [outcome, setOutcome] = useState<Outcome>({ busy: false, note: null, error: null });
  useEffect(() => {
    const back = takeInitialOrgConnectorReturn() ?? takeOrgConnectorReturn();
    if (back === null) return;
    if (back.kind === 'error') {
      setOutcome({ busy: false, note: null, error: back.error });
      return;
    }
    setOutcome({ busy: true, note: null, error: null });
    completeOrgConnectorSignIn(back.handoff)
      .then(() => {
        setOutcome({ busy: false, note: 'Signed in. The service answered with the new sign-in.', error: null });
        onDone();
      })
      .catch((err: unknown) => {
        setOutcome({ busy: false, note: null, error: queryError(err, 'The sign-in did not finish.') });
      });
  }, [onDone]);
  return outcome;
}

function Header({ connector, admin, onError }: { connector: OrgConnector; admin: boolean; onError: (message: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const status = orgConnectorStatus(connector);
  const signIn = (): void => {
    setBusy(true);
    signInOrgConnector(connector.id)
      .then(goExternal)
      .catch((err: unknown) => {
        onError(queryError(err, 'Could not start the sign-in.'));
        setBusy(false);
      });
  };
  return (
    <Col gap={16}>
      <BackLink label="Connectors" href={routeHash({ kind: 'org-connectors' })} />
      <Row justify="between" align="center" gap={16}>
        <Row gap={14} align="center" style={SHRINK}>
          <ConnectorFavicon name={connector.name} url={connector.url} size={ICON} />
          <Col gap={2} style={SHRINK}>
            <PageTitle>{connector.name}</PageTitle>
            <Text size="2xs" role={status.bad ? 'danger' : 'secondary'} numberOfLines={1}>
              {`${connectorHost(connector.url)} · ${status.text}`}
            </Text>
          </Col>
        </Row>
        {admin && connector.auth === 'oauth' ? <Button size="md" color={status.bad ? 'primary' : 'secondary'} dark={dark} label={status.bad ? 'Sign in' : 'Sign in again'} loading={busy} disabled={busy} onPress={signIn} /> : null}
      </Row>
    </Col>
  );
}

function Notes({ outcome, failure }: { outcome: Outcome; failure: string | null }): ReactNode {
  const error = failure ?? outcome.error;
  return (
    <>
      {outcome.busy ? <Text size="2xs" role="secondary">Finishing the sign-in…</Text> : null}
      {outcome.note === null ? null : <Text size="2xs" role="secondary">{outcome.note}</Text>}
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
    </>
  );
}

function Body({ id }: { id: string }): ReactNode {
  const client = useQueryClient();
  const { data, error } = useOrgConnectorsQuery();
  const [failure, setFailure] = useState<string | null>(null);
  const reload = useCallback(() => {
    refreshOrgConnectors(client).catch(logError('org-connector'));
  }, [client]);
  const outcome = useSignInReturn(reload);
  const connector = data?.connectors.find((c) => c.id === id);
  useDocumentTitle(connector?.name ?? 'Connector');
  if (error !== null) return <Text size="2xs" role="danger">{queryError(error, 'Could not load this connector.')}</Text>;
  if (data === undefined) return <Loading />;
  if (connector === undefined) return <Text size="2xs" role="danger">This connector is not in this organization any more.</Text>;
  return (
    <Col gap={32} width="100%">
      <Header connector={connector} admin={data.admin} onError={setFailure} />
      <Notes outcome={outcome} failure={failure} />
      <Text size="2xs" role="secondary">These settings are saved for a coming Metro update. Agents still use their own connectors for now.</Text>
      <OrgConnectorAgents connector={connector} admin={data.admin} onChanged={reload} />
      <OrgConnectorAccess connector={connector} admin={data.admin} onChanged={reload} />
      <OrgConnectorFacts connector={connector} />
      {data.admin ? <OrgConnectorManage connector={connector} onChanged={reload} /> : null}
      {data.admin ? <OrgConnectorActivity connector={connector.id} /> : null}
    </Col>
  );
}

export function OrgConnectorPage({ id, onLock }: { id: string; onLock: () => void }): ReactNode {
  const scope = useConnectorScope();
  return (
    <Frame sidebar={(closeMenu) => <PlainSidebar selection={{ kind: 'org-connector', id }} onSelect={closeMenu} />} onLock={onLock}>
      <Body key={`${String(scope)}:${id}`} id={id} />
    </Frame>
  );
}
