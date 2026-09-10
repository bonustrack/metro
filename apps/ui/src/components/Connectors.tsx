import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import {
  connectorsInOrder,
  deleteConnector,
  takeConnectorError,
  type ConnectorsView,
} from '../api/connectors.js';
import { AddConnector } from './AddConnector.js';
import { ConnectorRow } from './ConnectorRow.js';
import { CountBadge } from './CountBadge.js';
import { Loading } from './Loading.js';
import { useQueryClient } from '@tanstack/react-query';
import {
  queryError,
  refreshConnectors,
  useConnectorsQuery,
} from '../api/queries.js';
import { useDocumentTitle } from '../title.js';


const FALLBACK = 'Could not load your connectors.';
const WHAT =
  'Each of these is its own MCP server in Claude Code on this machine, reached through the daemon so the credential stays here. Adding, renaming or removing one reaches a Claude Code session started afterwards: a running session keeps the list it started with.';

interface ConnectorsBodyProps {
  project: string;
  onChanged: () => void;
  data: ConnectorsView;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}

function ConnectorsBody({
  project,
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
          project={project}
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
  project,
  onOpen,
}: {
  project: string;
  onOpen: (id: string) => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useConnectorsQuery();
  const reload = (): void => {
    refreshConnectors(client);
  };
  const remove = (id: string): Promise<void> =>
    deleteConnector(id).then(() => {
      refreshConnectors(client);
    });
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
          <Text size="sm" role="secondary">{WHAT}</Text>
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
          project={project}
          onChanged={reload}
          data={data}
          onOpen={onOpen}
          onDelete={remove}
          onError={setFailed}
        />
      )}

      <AddConnector
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
