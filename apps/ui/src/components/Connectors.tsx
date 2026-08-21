import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import {
  deleteConnector,
  takeConnectorError,
  type ConnectorList,
} from '../api/connectors';
import { AddConnector } from './AddConnector';
import { ConnectorRow } from './ConnectorRow';
import { CopyBlock } from './CopyBlock';
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

const EMPTY =
  'No connectors yet. Add one and Metro checks that the server answers before it stores anything. Metro holds the config for you to copy — it does not proxy these servers, and no agent connects through them.';

interface ConnectorsBodyProps {
  data: ConnectorList;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

function ConnectorsBody({ data, onOpen, onDelete }: ConnectorsBodyProps): ReactNode {
  const rows = data.connectors;
  if (rows.length === 0) return <Text size="sm" role="secondary">{EMPTY}</Text>;
  return (
    <>
      <Col>
        {rows.map((row) => (
          <ConnectorRow
            key={row.id}
            row={row}
            onOpen={onOpen}
            onDelete={onDelete}
          />
        ))}
      </Col>
      {rows.length > 1 ? (
        <Col>
          <CopyBlock
            key={data.json}
            label="all connectors"
            value={data.json}
            secret={rows.some((r) => r.secret !== null)}
          />
        </Col>
      ) : null}
    </>
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
  const [returned] = useState(takeConnectorError);

  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={2} style={SHRINK}>
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

      {returned === null ? null : (
        <Text size="sm" role="danger">{`Sign-in did not finish: ${returned}`}</Text>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data === undefined ? null : (
        <ConnectorsBody data={data} onOpen={onOpen} onDelete={remove} />
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
