import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { assignOrgConnector, setOrgConnectorAgentPolicy, unassignOrgConnector, type OrgConnector, type OrgConnectorAgent } from '@metro-labs/client/api/org-connectors';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { Modal } from '../Modal.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { Group, Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RuleChoice, RuleRows, useRuleSave, viewTitle, type RuleView } from './RuleViews.js';
import { useConnectorTools } from './ConnectorRule.js';
import { ownRuleLine } from '../../lib/rule-words.js';
import { queryError, useServerStatus, useServersQuery } from '../../lib/queries.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { AVATAR_SIZE } from '../ui/sizes.js';

const PLUS = 22;

function AgentFace({ server }: { server: Server }): ReactNode {
  const { data } = useServerStatus(server.host);
  const dot = data?.state === 'live' ? 'success' : data?.state === 'offline' ? 'danger' : null;
  return (
    <AvatarDot dot={dot}>
      <AgentAvatar seed={server.host} src={server.avatar} size={AVATAR_SIZE.row} />
    </AvatarDot>
  );
}

function useChange(onDone: () => void): { busy: boolean; error: string | null; run: (job: () => Promise<unknown>) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (job: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    job()
      .then(() => refreshOrgConnectors(client))
      .then(onDone)
      .catch((err: unknown) => { setError(queryError(err, 'Could not change that agent.')); })
      .finally(() => { setBusy(false); });
  };
  return { busy, error, run };
}

interface AgentModalProps {
  connector: OrgConnector;
  held: OrgConnectorAgent;
  server: Server;
  admin: boolean;
  onClose: () => void;
}

function AgentModal({ connector, held, server, admin, onClose }: AgentModalProps): ReactNode {
  const client = useQueryClient();
  const [view, setView] = useState<RuleView | null>(null);
  const tools = useConnectorTools(connector);
  const scope = tools.scope(held.policy, connector.policy);
  const saving = useRuleSave(async (next) => {
    await setOrgConnectorAgentPolicy(connector.id, server.id, next);
    await refreshOrgConnectors(client);
  });
  const removing = useChange(onClose);
  const name = serverLabel(server);
  if (view !== null)
    return (
      <Modal title={`${name}: ${viewTitle(view, scope.tools)}`} open onClose={onClose}>
        <RuleChoice view={view} scope={scope} disabled={!admin} busy={saving.busy} error={saving.error} onSave={saving.save} onPick={setView} onDone={() => { setView(null); }} onRefresh={tools.refresh} />
      </Modal>
    );
  return (
    <Modal title={name} open onClose={onClose}>
      <Col gap={20}>
        <Text size="md" role="secondary">{`${name} can be stricter than the organization, never looser. The stricter rule wins.`}</Text>
        <Rows>
          <RuleRows scope={scope} onOpen={setView} />
        </Rows>
        {admin ? (
          <Rows>
            <Item title={`Take ${connector.name} away from ${name}`} danger chevron={false} onPress={removing.busy ? undefined : () => { removing.run(() => unassignOrgConnector(connector.id, server.id)); }} />
          </Rows>
        ) : null}
        {removing.error === null ? null : <Text size="md" role="danger">{removing.error}</Text>}
      </Col>
    </Modal>
  );
}

function AddAgentModal({ connector, servers, onClose }: { connector: OrgConnector; servers: Server[]; onClose: () => void }): ReactNode {
  const adding = useChange(onClose);
  return (
    <Modal title="Add an agent" open onClose={onClose}>
      <Col gap={16}>
        <Text size="md" role="secondary">{`The agent gets ${connector.name} and follows the rule of the organization.`}</Text>
        {servers.length === 0 ? <Text size="md" role="secondary">Every agent has it already.</Text> : (
          <Rows>
            {servers.map((server) => (
              <Item key={server.id} title={serverLabel(server)} leading={<AgentAvatar seed={server.host} src={server.avatar} size={AVATAR_SIZE.row} />} chevron={false}
                onPress={adding.busy ? undefined : () => { adding.run(() => assignOrgConnector(connector.id, server.id)); }} />
            ))}
          </Rows>
        )}
        {adding.error === null ? null : <Text size="md" role="danger">{adding.error}</Text>}
      </Col>
    </Modal>
  );
}

function AddRow({ onPress }: { onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  return <Item title="Add an agent" leading={<Icon name="plus" size={PLUS} color={palette.link} />} chevron={false} onPress={onPress} />;
}

export function ConnectorAgents({ connector, admin }: { connector: OrgConnector; admin: boolean }): ReactNode {
  const servers = useServersQuery();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const all = servers.data ?? [];
  const held = connector.agents.flatMap((agent) => {
    const server = all.find((s) => s.id === agent.id);
    return server === undefined ? [] : [{ agent, server }];
  });
  const others = all.filter((server) => !connector.agents.some((agent) => agent.id === server.id));
  const selected = held.find((entry) => entry.server.id === open);
  const note = servers.error === null ? (held.length === 0 ? 'No agent has it yet.' : undefined) : queryError(servers.error, 'Could not load the agents.');
  return (
    <Group label="Agents" note={note}>
      {held.map(({ agent, server }) => (
        <Item key={server.id} title={serverLabel(server)} subtitle={ownRuleLine(agent.policy)} leading={<AgentFace server={server} />} onPress={() => { setOpen(server.id); }} />
      ))}
      {admin && others.length > 0 ? <AddRow onPress={() => { setAdding(true); }} /> : null}
      {selected === undefined ? null : <AgentModal connector={connector} held={selected.agent} server={selected.server} admin={admin} onClose={() => { setOpen(null); }} />}
      {adding ? <AddAgentModal connector={connector} servers={others} onClose={() => { setAdding(false); }} /> : null}
    </Group>
  );
}
