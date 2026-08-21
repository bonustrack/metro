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
import { claudeSessionCommand } from '../api/install';
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

const SESSION_HINT =
  'Paste this in a terminal to start Claude Code with every connector loaded, credentials included. It carries them in the clear, so it belongs in a terminal, not in a commit.';

interface ConnectorsBodyProps {
  data: ConnectorList;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}

function ConnectorsBody({
  data,
  onOpen,
  onDelete,
  onError,
}: ConnectorsBodyProps): ReactNode {
  const rows = data.connectors;
  if (rows.length === 0) return null;
  return (
    <>
      <Col>
        {rows.map((row) => (
          <ConnectorRow
            key={row.id}
            row={row}
            onOpen={onOpen}
            onDelete={onDelete}
            onError={onError}
          />
        ))}
      </Col>
      <Col gap={4}>
        <CopyBlock
          key={data.json}
          label="start claude code with all of them"
          value={claudeSessionCommand(data.json)}
          secret
        />
        <Text size="sm" role="secondary">{SESSION_HINT}</Text>
      </Col>
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
  const [failed, setFailed] = useState<string | null>(null);
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
      {failed === null ? null : (
        <Text size="sm" role="danger">{failed}</Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data === undefined ? null : (
        <ConnectorsBody
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
