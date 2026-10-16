import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { assignOrgConnector, setOrgConnectorAgentPolicy, unassignOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import type { ToolPolicy } from '@metro-labs/client/api/policy';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { StateBlock } from '../ui/StateBlock.js';
import { ToolExplorer } from './ToolExplorer.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';
import { logError } from '../../lib/log.js';
import { useIsNarrow } from '../../lib/media.js';

interface AgentRulesProps {
  connector: OrgConnector;
  agentId: string;
  name: string;
  admin: boolean;
  onRemoved: () => void;
}

const isEmpty = (policy: ToolPolicy): boolean => policy.read === undefined && policy.write === undefined && Object.keys(policy.tools ?? {}).length === 0;

export const agentSubtitle = (connector: OrgConnector, name: string): string => `${connector.name} tools for ${name}. ${name} can only be stricter than the organization.`;

interface Reset {
  shown: boolean;
  busy: boolean;
  empty: boolean;
  reset: () => void;
}

function useReset(connector: OrgConnector, agentId: string): Reset {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const own = connector.agents.find((agent) => agent.id === agentId)?.policy;
  const reset = (): void => {
    setBusy(true);
    setOrgConnectorAgentPolicy(connector.id, agentId, {})
      .then(() => refreshOrgConnectors(client))
      .catch(logError('connector-reset'))
      .finally(() => { setBusy(false); });
  };
  return { shown: own !== undefined, busy, empty: own === undefined || isEmpty(own), reset };
}

export function ResetRules({ connector, agentId }: { connector: OrgConnector; agentId: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const narrow = useIsNarrow();
  const reset = useReset(connector, agentId);
  if (!reset.shown || narrow) return null;
  return <Button color="secondary" dark={dark} label="Reset to the organization" loading={reset.busy} disabled={reset.busy || reset.empty} onPress={reset.reset} />;
}

function ResetRow({ connector, agentId, name }: { connector: OrgConnector; agentId: string; name: string }): ReactNode {
  const reset = useReset(connector, agentId);
  if (reset.empty) return null;
  return <Item title="Reset to the organization" subtitle={`${name} follows only the rules of the organization again.`} chevron={false} onPress={reset.busy ? undefined : reset.reset} />;
}

function NotAssigned({ connector, agentId, name, admin }: Omit<AgentRulesProps, 'onRemoved'>): ReactNode {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = (): void => {
    setBusy(true);
    setError(null);
    assignOrgConnector(connector.id, agentId)
      .then(() => refreshOrgConnectors(client))
      .catch((err: unknown) => { setError(queryError(err, `Could not add ${connector.name}.`)); })
      .finally(() => { setBusy(false); });
  };
  return (
    <StateBlock icon="plug" title={`${name} does not have ${connector.name}`} text={error ?? (admin ? `Add it to give ${name} these tools.` : 'An admin of the organization can add it.')}
      action={admin ? { label: `Add ${connector.name}`, busy, onPress: add } : undefined} />
  );
}

export function AgentRules({ connector, agentId, name, admin, onRemoved }: AgentRulesProps): ReactNode {
  const client = useQueryClient();
  const narrow = useIsNarrow();
  const held = connector.agents.find((agent) => agent.id === agentId);
  const removing = useConfirm(async () => {
    await unassignOrgConnector(connector.id, agentId);
    await refreshOrgConnectors(client);
  }, `Could not remove ${connector.name}.`, onRemoved);
  if (held === undefined) return <NotAssigned connector={connector} agentId={agentId} name={name} admin={admin} />;
  const save = async (next: ToolPolicy): Promise<void> => {
    await setOrgConnectorAgentPolicy(connector.id, agentId, next);
    await refreshOrgConnectors(client);
  };
  return (
    <Groups>
      <ToolExplorer connector={connector} scope={{ policy: held.policy, organization: connector.policy }} editable={admin} save={save} />
      {admin ? (
        <Group label="Danger">
          {narrow ? <ResetRow connector={connector} agentId={agentId} name={name} /> : null}
          <Item title={`Remove ${connector.name} from ${name}`} subtitle={`${name} loses these tools at once.`} danger chevron={false} onPress={removing.show} />
        </Group>
      ) : null}
      <ConfirmDialog confirming={removing} title={`Remove ${connector.name} from ${name}?`} lines={[`${name} loses the ${connector.name} tools at once. You can add it again later.`]} action="Remove" word={name} />
    </Groups>
  );
}
