import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import { connectorHost, verifyConnector, type Connector } from '../api/connectors.js';
import { useQueryClient } from '@tanstack/react-query';
import {
  queryError,
  refreshConnectors,
  useConnectorQuery,
} from '../api/queries.js';
import { BackLink } from './BackLink.js';
import { routeHash } from '../route.js';
import { ConnectorActions } from './ConnectorActions.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { Field } from './Field.js';
import { Loading } from './Loading.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not load this connector.';

const AUTH_LABEL: Record<string, string> = {
  oauth: 'OAuth',
  header: 'Header',
  none: 'None',
};

interface ConnectorPageProps {
  project: string;
  id: string;
  onDelete: (id: string) => Promise<void>;
  onBack: () => void;
}

function whenLabel(at: string): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? '-' : new Date(ms).toLocaleString();
}

function ConnectorFacts({ connector }: { connector: Connector }): ReactNode {
  const verified = connector.verified;
  return (
    <Row gap={20} wrap>
      {verified === null || verified.server === '' ? null : <Field label="server" value={verified.server} />}
      <Field label="sign-in" value={AUTH_LABEL[connector.auth] ?? 'None'} />
      {connector.clientId === null ? null : <Field label="app" value={connector.clientId} />}
      {verified === null || verified.at === '' ? null : <Field label="checked" value={whenLabel(verified.at)} />}
    </Row>
  );
}

function HealthLine({ connector }: { connector: Connector }): ReactNode {
  const health = connector.health;
  if (health === null)
    return (
      <Text size="sm" role="secondary">
        No call has gone through this connector since Metro started.
      </Text>
    );
  const when = whenLabel(health.at);
  return (
    <Text size="sm" role={health.ok ? 'secondary' : 'danger'}>
      {health.ok ? `Answering. Last call ${when}.` : `${health.reason ?? 'The last call failed'} (${when}).`}
    </Text>
  );
}

const HEADING_ICON_SIZE = 44;

function ConnectorHeading({
  connector,
}: {
  connector: Connector;
}): ReactNode {
  return (
    <Row gap={14} align="center" style={SHRINK}>
      <ConnectorFavicon
        name={connector.name}
        url={connector.url}
        size={HEADING_ICON_SIZE}
      />
      <Col gap={8} style={SHRINK}>
        <PageTitle>{connector.name}</PageTitle>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {connectorHost(connector.url)}
        </Text>
      </Col>
    </Row>
  );
}

export function ConnectorPage({
  project,
  id,
  onDelete,
  onBack,
}: ConnectorPageProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useConnectorQuery(id);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useDocumentTitle(data?.name ?? 'Connector');

  const reload = (): void => {
    setStatus(null);
    refreshConnectors(client, id);
  };

  const recheck = (): void => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    verifyConnector(id)
      .then((result) => {
        setStatus(result.ok ? 'Answered just now.' : (result.reason ?? 'It did not answer.'));
        refreshConnectors(client, id);
      })
      .catch((err: unknown) => {
        setStatus(queryError(err, 'Could not check the connector.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (error !== null)
    return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;

  return (
    <Col gap={20}>
      <Col gap={12}>
        <Row justify="between" align="center" gap={12}>
          <BackLink
            label="Connectors"
            href={routeHash({ kind: 'connectors', project })}
            onPress={onBack}
          />
          <ConnectorActions
            connector={data}
            refreshing={busy}
            onRefresh={recheck}
            onDelete={onDelete}
            onChanged={reload}
            onError={setStatus}
          />
        </Row>
        <ConnectorHeading connector={data} />
      </Col>

      <ConnectorFacts connector={data} />
      <HealthLine connector={data} />
      {status !== null ? <Text size="sm" role="secondary">{status}</Text> : null}
    </Col>
  );
}
