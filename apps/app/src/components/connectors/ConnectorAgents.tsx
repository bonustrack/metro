import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { assignOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { Modal } from '../Modal.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group, Groups, Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AgentFace, SummaryLine } from './AgentFace.js';
import { useAgentRows, type AgentRow } from '../../lib/agent-rows.js';
import { explorerTools, type ExplorerTool } from '../../lib/connector-rules.js';
import { agentRuleSummary } from '../../lib/connector-summary.js';
import { refreshOrgConnectors, useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';
import { queryError, useServersQuery } from '../../lib/queries.js';
import { routeHash } from '@metro-labs/client/route';

interface Split {
  held: AgentRow[];
  others: AgentRow[];
}

const byName = (a: AgentRow, b: AgentRow): number => a.name.localeCompare(b.name);

function useSplit(connector: OrgConnector, servers: Server[]): Split {
  const rows = useAgentRows(servers);
  const holds = new Set(connector.agents.map((agent) => agent.id));
  return { held: rows.filter((row) => holds.has(row.server.id)).sort(byName), others: rows.filter((row) => !holds.has(row.server.id)).sort(byName) };
}

function useAssign(onDone?: () => void): { busy: string | null; error: string | null; add: (connector: OrgConnector, server: Server) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = (connector: OrgConnector, server: Server): void => {
    if (busy !== null) return;
    setBusy(server.id);
    setError(null);
    assignOrgConnector(connector.id, server.id)
      .then(() => refreshOrgConnectors(client))
      .then(() => { onDone?.(); })
      .catch((err: unknown) => { setError(queryError(err, `Could not add ${connector.name} to ${serverLabel(server)}.`)); })
      .finally(() => { setBusy(null); });
  };
  return { busy, error, add };
}

function AddModal({ connector, others, onClose }: { connector: OrgConnector; others: AgentRow[]; onClose: () => void }): ReactNode {
  const assign = useAssign(onClose);
  return (
    <Modal title="Add an agent" open onClose={onClose}>
      <Col gap={16}>
        <Text size="md" role="secondary">{`The agent gets ${connector.name} with the rules of the organization.`}</Text>
        {others.length === 0 ? (
          <Text size="md" role="secondary">Every agent has it already.</Text>
        ) : (
          <Rows>
            {others.map((row) => (
              <Item key={row.server.id} title={row.name} subtitle={row.line.text} leading={<AgentFace server={row.server} dot={row.line.dot} />} chevron={false}
                onPress={assign.busy === null ? () => { assign.add(connector, row.server); } : undefined} />
            ))}
          </Rows>
        )}
        {assign.error === null ? null : <Text size="md" role="danger">{assign.error}</Text>}
      </Col>
    </Modal>
  );
}

export function useAddAgent(connector: OrgConnector): { open: () => void; modal: ReactNode } {
  const servers = useServersQuery().data ?? [];
  const { others } = useSplit(connector, servers);
  const [adding, setAdding] = useState(false);
  return { open: () => { setAdding(true); }, modal: adding ? <AddModal connector={connector} others={others} onClose={() => { setAdding(false); }} /> : null };
}

function HeldRows({ connector, held, tools }: { connector: OrgConnector; held: AgentRow[]; tools: ExplorerTool[] | null }): ReactNode {
  const note = `An agent can only be stricter than the organization. Open one to change its rules or remove ${connector.name} from it.`;
  const count = held.length;
  return (
    <Group label={count === 0 ? `No agent has ${connector.name} yet` : `${String(count)} ${count === 1 ? 'agent has' : 'agents have'} ${connector.name}`} note={count === 0 ? undefined : note} wide>
      {held.map((row) => {
        const own = connector.agents.find((agent) => agent.id === row.server.id)?.policy ?? {};
        return (
          <Item key={row.server.id} title={row.name} subtitle={<SummaryLine summary={agentRuleSummary(connector.policy, own, tools)} />} leading={<AgentFace server={row.server} dot={row.line.dot} />}
            href={routeHash({ kind: 'org-connector', id: connector.id, tab: 'agents', agent: row.server.id })} />
        );
      })}
    </Group>
  );
}

function OtherRows({ connector, others, admin }: { connector: OrgConnector; others: AgentRow[]; admin: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const assign = useAssign();
  if (others.length === 0) return null;
  return (
    <Group label={`Without ${connector.name}`} error={assign.error} wide>
      {others.map((row) => (
        <Item key={row.server.id} title={row.name} subtitle={row.line.text} subtitleTone={row.line.tone} leading={<AgentFace server={row.server} dot={row.line.dot} />} chevron={false}
          trailing={admin ? <Button color="secondary" dark={dark} label="Add" loading={assign.busy === row.server.id} disabled={assign.busy !== null} onPress={() => { assign.add(connector, row.server); }} /> : undefined} />
      ))}
    </Group>
  );
}

function Lists({ connector, admin, servers }: { connector: OrgConnector; admin: boolean; servers: Server[] }): ReactNode {
  const { held, others } = useSplit(connector, servers);
  const listed = useOrgConnectorToolsQuery(connector.id).data;
  const tools = listed === undefined ? null : explorerTools(listed, [connector.policy]);
  return (
    <Groups>
      <HeldRows connector={connector} held={held} tools={tools} />
      <OtherRows connector={connector} others={others} admin={admin} />
    </Groups>
  );
}

export function ConnectorAgents({ connector, admin }: { connector: OrgConnector; admin: boolean }): ReactNode {
  const servers = useServersQuery();
  if (servers.data === undefined && servers.error !== null) return <ErrorState title="Could not load the agents" text={queryError(servers.error, 'Metro did not answer.')} onRetry={servers.refetch} />;
  if (servers.data === undefined) return <RowsSkeleton rows={4} />;
  return <Lists connector={connector} admin={admin} servers={servers.data} />;
}
