import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { CountBadge } from './CountBadge';
import { ConnectorFavicon } from './ConnectorFavicon';
import { KebabMenu } from './KebabMenu';
import { AddConnectors } from './AddConnectors';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import {
  removeAgentConnector,
  setAgentConnectors,
} from '../api/agent-connectors';
import { type AgentSummary } from '../api/client';
import { connectorHost, type Connector } from '../api/connectors';
import { queryError, refreshAgents, useConnectorsQuery } from '../api/queries';

const ROW_PAD_Y = 10;
const ICON_SIZE = 16;
const EMPTY =
  'No connectors yet. Add some with the button above, or open a connector and use Add to agent from its menu.';
const EMPTY_READ_ONLY = 'This agent holds no connectors.';

function MemberRow({
  connector,
  project,
  busy,
  onOpen,
  onRemove,
}: {
  connector: Connector;
  project: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onRemove?: () => void;
}): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      justify="between"
      align="center"
      gap={12}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <a
        className="row-link"
        href={routeHash({ kind: 'connector', project, id: connector.id })}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen(connector.id);
        }}
      >
        <ConnectorFavicon
          name={connector.name}
          url={connector.url}
          size={ICON_SIZE}
        />
        <Row
          gap={10}
          align="center"
          flex={1}
          minWidth={0}
          padding={{ y: ROW_PAD_Y }}
        >
          <span className="row-title">
            <Text size="md" weight="semibold" numberOfLines={1}>
              {connector.name}
            </Text>
          </span>
          <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
            {connectorHost(connector.url)}
          </Text>
        </Row>
      </a>
      {onRemove === undefined ? null : (
        <KebabMenu
          label={`Actions for ${connector.name}`}
          size="lg"
          items={[
            {
              label: busy ? 'Removing…' : 'Remove from agent',
              danger: true,
              onSelect: onRemove,
            },
          ]}
        />
      )}
    </Row>
  );
}

function Heading({
  count,
  owned,
  onAdd,
}: {
  count: number;
  owned: boolean;
  onAdd: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="between" align="center" gap={12}>
      <Row gap={10} align="center">
        <Text size="lg" weight="semibold">
          Connectors
        </Text>
        <CountBadge count={count} />
      </Row>
      {owned ? (
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          label="Add connectors"
          onPress={onAdd}
        />
      ) : null}
    </Row>
  );
}

function Members({
  rows,
  project,
  owned,
  busy,
  onOpen,
  onDrop,
}: {
  rows: Connector[];
  project: string;
  owned: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onDrop: (id: string) => void;
}): ReactNode {
  if (rows.length === 0)
    return (
      <Text size="sm" role="secondary">
        {owned ? EMPTY : EMPTY_READ_ONLY}
      </Text>
    );
  return (
    <Col>
      {rows.map((row) => (
        <MemberRow
          key={row.id}
          connector={row}
          project={project}
          busy={busy}
          onOpen={onOpen}
          onRemove={
            owned
              ? () => {
                  onDrop(row.id);
                }
              : undefined
          }
        />
      ))}
    </Col>
  );
}

interface AgentConnectorsProps {
  token: string;
  project: string;
  agent: AgentSummary;
  onOpen: (id: string) => void;
}

export function AgentConnectors({
  token,
  project,
  agent,
  onOpen,
}: AgentConnectorsProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useConnectorsQuery(token, project);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const all = data?.connectors ?? [];
  const rows = all.filter((row) => agent.connectorIds.includes(row.id));

  const reload = (): void => {
    refreshAgents(client, project);
  };

  const drop = (connectorId: string): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    removeAgentConnector(token, agent.id, connectorId)
      .then(reload)
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not update the agent.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Col gap={10}>
      <Heading
        count={agent.connectorIds.length}
        owned={agent.owned}
        onAdd={() => {
          setAdding(true);
        }}
      />
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load the connectors.')}
        </Text>
      )}
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
      <Members
        rows={rows}
        project={project}
        owned={agent.owned}
        busy={busy}
        onOpen={onOpen}
        onDrop={drop}
      />
      {agent.owned ? (
        <AddConnectors
          key={agent.connectorIds.join(',')}
          token={token}
          project={project}
          title={`Connectors for ${agent.name}`}
          action="Save"
          initial={agent.connectorIds}
          open={adding}
          onClose={() => {
            setAdding(false);
          }}
          onSubmit={async (ids) => {
            await setAgentConnectors(token, agent.id, agent.connectorIds, ids);
            reload();
          }}
        />
      ) : null}
    </Col>
  );
}
