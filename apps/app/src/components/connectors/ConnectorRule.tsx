import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setOrgConnectorPolicy, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { Modal } from '../Modal.js';
import { Group } from '../ui/Group.js';
import { RuleChoice, RuleRows, useRuleSave, viewTitle, type RuleScope, type RuleView } from './RuleViews.js';
import { refreshOrgConnectors, useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';
import { logError } from '../../lib/log.js';

export function useConnectorTools(connector: OrgConnector): { scope: (policy: RuleScope['policy'], organization?: RuleScope['policy']) => RuleScope; note: string | undefined; refresh: () => void } {
  const tools = useOrgConnectorToolsQuery(connector.id);
  const list = tools.data ?? [];
  const note = tools.error === null ? undefined : `${queryError(tools.error, 'Could not list the tools.')} Saved rules are kept.`;
  return {
    scope: (policy, organization) => ({ policy, organization, tools: list, connector: connector.name }),
    note,
    refresh: () => { tools.refetch().catch(logError('org-connector-tools')); },
  };
}

export function ConnectorRule({ connector, admin }: { connector: OrgConnector; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const [view, setView] = useState<RuleView | null>(null);
  const tools = useConnectorTools(connector);
  const scope = tools.scope(connector.policy);
  const saving = useRuleSave(async (next) => {
    await setOrgConnectorPolicy(connector.id, next);
    await refreshOrgConnectors(client);
  });
  return (
    <Group label="What agents may do" note={tools.note}>
      <RuleRows scope={scope} onOpen={setView} />
      {view === null ? null : (
        <Modal title={viewTitle(view, scope.tools)} open onClose={() => { setView(null); }}>
          <RuleChoice view={view} scope={scope} disabled={!admin} busy={saving.busy} error={saving.error} onSave={saving.save}
            onPick={setView} onDone={() => { setView(null); }} onRefresh={tools.refresh} />
        </Modal>
      )}
    </Group>
  );
}
