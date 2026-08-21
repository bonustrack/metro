import { type ReactNode, useCallback, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { CARD_PADDING } from '../theme';
import {
  connectorHost,
  deleteConnector,
  fetchConnectors,
  serverLabel,
  verifyConnector,
  type Connector,
  type ConnectorList,
} from '../api/connectors';
import { AddConnector } from './AddConnector';
import { CopyBlock } from './CopyBlock';
import { DeleteConnector } from './DeleteConnector';
import { Field } from './Field';
import { Loading } from './Loading';
import { loadError, useLoad } from '../load';
import { useDocumentTitle } from '../title';

const BLURB = 'Remote MCP servers Metro has checked for you.';

const FALLBACK = 'Could not load your connectors.';

const EMPTY =
  'No connectors yet. Add one and Metro checks that the server answers before it stores anything. Metro holds the config for you to copy — it does not proxy these servers, and no agent connects through them.';

type DeleteHandler = (id: number) => Promise<void>;

function whenLabel(at: string): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? '-' : new Date(ms).toLocaleString();
}

interface ConnectorCardProps {
  token: string;
  row: Connector;
  onDelete: DeleteHandler;
}

function ConnectorCard({ token, row, onDelete }: ConnectorCardProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const verified = row.verified;

  const recheck = (): void => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    verifyConnector(token, row.id)
      .then((result) => {
        setStatus(result.ok ? 'Answered just now.' : (result.reason ?? 'It did not answer.'));
      })
      .catch((err: unknown) => {
        setStatus(loadError(err, 'Could not check the connector.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card dark={dark} padding={CARD_PADDING}>
      <Col gap={12}>
        <Row justify="between" align="start" gap={12}>
          <Col gap={2} style={{ flexShrink: 1, minWidth: 0 }}>
            <Text size="lg" weight="semibold">{row.name}</Text>
            <Text size="sm" role="secondary" numberOfLines={1}>
              {connectorHost(row.url)}
            </Text>
          </Col>
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
            <DeleteConnector connector={row} onDelete={onDelete} />
          </Row>
        </Row>
        {verified === null ? null : (
          <Row gap={20} wrap>
            <Field label="tools" value={String(verified.tools)} />
            <Field label="server" value={serverLabel(verified)} />
            <Field label="verified" value={whenLabel(verified.at)} />
          </Row>
        )}
        {status !== null ? <Text size="sm" role="secondary">{status}</Text> : null}
        <CopyBlock
          key={row.json}
          label="mcp config"
          value={row.json}
          secret={row.secret !== null}
          hide={row.secret}
        />
      </Col>
    </Card>
  );
}

interface ConnectorsBodyProps {
  token: string;
  data: ConnectorList;
  onDelete: DeleteHandler;
}

function ConnectorsBody({ token, data, onDelete }: ConnectorsBodyProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const rows = data.connectors;
  if (rows.length === 0) return <Text size="sm" role="secondary">{EMPTY}</Text>;
  return (
    <>
      <Col gap={10}>
        {rows.map((row) => (
          <ConnectorCard key={row.id} token={token} row={row} onDelete={onDelete} />
        ))}
      </Col>
      {rows.length > 1 ? (
        <Card dark={dark} padding={CARD_PADDING}>
          <CopyBlock
            key={data.json}
            label="all connectors"
            value={data.json}
            secret={rows.some((r) => r.secret !== null)}
          />
        </Card>
      ) : null}
    </>
  );
}

export function Connectors({ token }: { token: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const load = useCallback(() => fetchConnectors(token), [token]);
  const { data, error, reload } = useLoad(load, FALLBACK);
  useDocumentTitle('Connectors');
  const [adding, setAdding] = useState(false);

  const remove = async (id: number): Promise<void> => {
    await deleteConnector(token, id);
    reload();
  };

  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={2} style={{ flexShrink: 1, minWidth: 0 }}>
          <PageTitle>Connectors</PageTitle>
          <Text size="sm" role="secondary">{BLURB}</Text>
        </Col>
        <Button
          color="primary"
          dark={dark}
          label="Add connector"
          onPress={() => {
            setAdding(true);
          }}
        />
      </Row>

      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      {data === null && error === null ? <Loading /> : null}
      {data === null ? null : (
        <ConnectorsBody token={token} data={data} onDelete={remove} />
      )}

      <AddConnector
        token={token}
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        onAdded={reload}
      />
    </Col>
  );
}
