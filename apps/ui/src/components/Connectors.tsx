import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import {
  connectorsInOrder,
  deleteConnector,
  takeConnectorError,
  type ConnectorList,
} from '../api/connectors';
import { AddConnector } from './AddConnector';
import { ConnectorRow } from './ConnectorRow';
import { CountBadge } from './CountBadge';
import { Loading } from './Loading';
import { useQueryClient } from '@tanstack/react-query';
import {
  connectorsKey,
  queryError,
  useConnectorsQuery,
} from '../api/queries';
import { useDocumentTitle } from '../title';

const BLURB = 'Remote MCP servers Metro has checked for you.';

const FALLBACK = 'Could not load your connectors.';

interface ConnectorsBodyProps {
  token: string;
  onChanged: () => void;
  data: ConnectorList;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}

function ConnectorsBody({
  token,
  onChanged,
  data,
  onOpen,
  onDelete,
  onError,
}: ConnectorsBodyProps): ReactNode {
  const rows = connectorsInOrder(data.connectors);
  if (rows.length === 0) return null;
  return (
    <Col>
      {rows.map((row) => (
        <ConnectorRow
          key={row.id}
          token={token}
          onChanged={onChanged}
          row={row}
          onOpen={onOpen}
          onDelete={onDelete}
          onError={onError}
        />
      ))}
    </Col>
  );
}

export function Connectors({
  token,
  onOpen,
}: {
  token: string;
  onOpen: (id: string) => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useConnectorsQuery(token);
  const reload = (): void => {
    client
      .invalidateQueries({ queryKey: connectorsKey() })
      .catch(() => undefined);
  };
  const remove = async (id: string): Promise<void> => {
    await deleteConnector(token, id);
    await client.invalidateQueries({ queryKey: connectorsKey() });
  };
  useDocumentTitle('Connectors');
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [returned] = useState(takeConnectorError);

  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={8} style={SHRINK}>
          <Row gap={10} align="center">
            <PageTitle>Connectors</PageTitle>
            {data === undefined ? null : (
              <CountBadge count={data.connectors.length} beside="title" />
            )}
          </Row>
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

      {returned === null ? null : (
        <Text size="sm" role="danger">{`Sign-in did not finish: ${returned}`}</Text>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>
      )}
      {failed === null ? null : (
        <Text size="sm" role="danger">{failed}</Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data === undefined ? null : (
        <ConnectorsBody
          token={token}
          onChanged={reload}
          data={data}
          onOpen={onOpen}
          onDelete={remove}
          onError={setFailed}
        />
      )}

      <AddConnector
        token={token}
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        onAdded={(id) => {
          reload();
          onOpen(id);
        }}
      />
    </Col>
  );
}
