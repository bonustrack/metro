import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
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
  connectorKey,
  connectorsKey,
  queryError,
  useConnectorQuery,
} from '../api/queries';
import { ConnectorIcon } from './ConnectorIcon';
import { CopyBlock } from './CopyBlock';
import { DeleteConnector } from './DeleteConnector';
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
  token: string;
  id: string;
  onDelete: (id: string) => Promise<void>;
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

function ConnectorHeading({
  connector,
}: {
  connector: Connector;
}): ReactNode {
  return (
    <Row gap={12} align="center" style={SHRINK}>
      <ConnectorIcon
        name={connector.name}
        url={connector.url}
        icon={connector.verified?.icon ?? ''}
        size={40}
      />
      <Col gap={2} style={SHRINK}>
        <PageTitle>{connector.name}</PageTitle>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {connectorHost(connector.url)}
        </Text>
      </Col>
    </Row>
  );
}

export function ConnectorPage({
  token,
  id,
  onDelete,
}: ConnectorPageProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useConnectorQuery(token, id);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useDocumentTitle(data?.name ?? 'Connector');

  const recheck = (): void => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    verifyConnector(token, id)
      .then(async (result) => {
        setStatus(result.ok ? 'Answered just now.' : (result.reason ?? 'It did not answer.'));
        await client.invalidateQueries({ queryKey: connectorKey(id) });
        await client.invalidateQueries({ queryKey: connectorsKey() });
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
      <Row justify="between" align="start" gap={12} wrap>
        <ConnectorHeading connector={data} />
        <Row gap={8} align="center">
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            onPress={recheck}
            loading={busy}
            disabled={busy}
            label="Check"
          />
          <DeleteConnector connector={data} onDelete={onDelete} />
        </Row>
      </Row>

      <ConnectorFacts connector={data} />
      {status !== null ? <Text size="sm" role="secondary">{status}</Text> : null}

      <Col>
        <CopyBlock
          key={data.json}
          label="mcp config"
          value={data.json}
          secret={data.secret !== null}
          hide={data.secret}
        />
      </Col>

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
