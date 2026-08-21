import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { takeConnectorError, type ConnectorList } from '../api/connectors';
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
  onOpen: (id: number) => void;
}

function ConnectorsBody({ data, onOpen }: ConnectorsBodyProps): ReactNode {
  const rows = data.connectors;
  if (rows.length === 0) return <Text size="sm" role="secondary">{EMPTY}</Text>;
  return (
    <>
      <Col>
        {rows.map((row) => (
          <ConnectorRow key={row.id} row={row} onOpen={onOpen} />
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
  onOpen: (id: number) => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useConnectorsQuery(token);
  const reload = (): void => {
    client
      .invalidateQueries({ queryKey: connectorsKey() })
      .catch(() => undefined);
  };
  useDocumentTitle('Connectors');
  const [adding, setAdding] = useState(false);
  const [returned] = useState(takeConnectorError);

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

      {returned === null ? null : (
        <Text size="sm" role="danger">{`Sign-in did not finish: ${returned}`}</Text>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data === undefined ? null : (
        <ConnectorsBody data={data} onOpen={onOpen} />
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
