import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import {
  connectorHost,
  serverLabel,
  verifyConnector,
  type Connector,
} from '../api/connectors';
import { useQueryClient } from '@tanstack/react-query';
import {
  queryError,
  refreshConnectors,
  useConnectorQuery,
} from '../api/queries';
import { BackLink } from './BackLink';
import { routeHash } from '../route';
import { ConnectorActions } from './ConnectorActions';
import { ConnectorFavicon } from './ConnectorFavicon';
import { Field } from './Field';
import { Loading } from './Loading';
import { ToolList } from './ToolList';
import { useDocumentTitle } from '../title';

const FALLBACK = 'Could not load this connector.';

const AUTH_LABEL: Record<string, string> = {
  oauth: 'OAuth',
  header: 'Header',
  none: 'None',
};

const HINT =
  'Grouping comes from the annotations the server publishes. A tool counts as read-only only when it says so, so anything unannotated is grouped with write/delete. These are hints, not guarantees — MCP says to treat them as untrusted unless you trust the server.';

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

function ConnectorFacts({
  connector,
}: {
  connector: Connector;
}): ReactNode {
  const verified = connector.verified;
  if (verified === null) return null;
  return (
    <Row gap={20} wrap>
      <Field label="tools" value={String(verified.tools)} />
      <Field label="server" value={serverLabel(verified)} />
      <Field label="protocol" value={verified.protocol} />
      <Field label="sign-in" value={AUTH_LABEL[connector.auth] ?? 'None'} />
      <Field label="checked" value={whenLabel(verified.at)} />
    </Row>
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
  const tools = data.verified?.catalog ?? [];

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
      {status !== null ? <Text size="sm" role="secondary">{status}</Text> : null}

      <Col gap={10}>
        <Col gap={2}>
          <Text size="lg" weight="semibold">Tools</Text>
          <Text size="sm" role="secondary">{HINT}</Text>
        </Col>
        <ToolList tools={tools} recorded={data.verified?.tools ?? 0} />
      </Col>
    </Col>
  );
}
