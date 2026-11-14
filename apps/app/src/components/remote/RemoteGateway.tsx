import { type ReactNode } from 'react';
import type { OrgModels } from '@metro-labs/client/api/org-models';
import { ownNote, RouteChoice, UsageAndLinks, useEditing } from '../models/AgentRoute.js';
import { OrgRouteSetup } from '../models/RouteSetup.js';
import { NoteRow } from '../settings/rows.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group, Groups } from '../ui/Group.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { useOrgModelsQuery } from '../../lib/model-queries.js';
import { queryError } from '../../lib/queries.js';

const NO_MODEL_ADMIN = 'No model is set up for this agent yet: choose one below, or a default route on the organization’s Gateway page.';
const NO_MODEL_MEMBER = 'No model is set up for this agent yet: an admin of the organization can choose one.';

function Route({ org, agent, name }: { org: OrgModels; agent: string; name: string }): ReactNode {
  const editing = useEditing(org, agent);
  const { admin } = org;
  const route = editing.scope.route;
  return (
    <>
      {route === null ? (
        <Group label="Needs attention">
          <NoteRow text={admin ? NO_MODEL_ADMIN : NO_MODEL_MEMBER} danger />
        </Group>
      ) : null}
      <RouteChoice editing={editing} name={name} locked={!admin} />
      <OrgRouteSetup route={route} connections={org.connections} who={name} mainNote={admin ? ownNote(editing, name) : undefined} edit={admin ? { control: editing.control, scope: editing.scope } : undefined} />
    </>
  );
}

export function RemoteGateway({ agent, name }: { agent: string; name: string }): ReactNode {
  const org = useOrgModelsQuery();
  if (org.data === undefined) {
    if (org.error === null) return <RowsSkeleton rows={3} />;
    return <ErrorState title="Could not load the models" text={queryError(org.error, 'Metro did not answer.')} onRetry={org.refetch} />;
  }
  return (
    <Groups>
      <Route org={org.data} agent={agent} name={name} />
      <UsageAndLinks agent={agent} />
    </Groups>
  );
}
