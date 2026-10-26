import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { routeHash } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { ListPaneRow } from '../ui/ListPaneRow.js';
import { ListPane } from '../shell/ListPane.js';
import { IconMark } from './Marks.js';
import type { IconName } from '../Icon.js';
import { useAdminOrganizations, useAdminUsers, useEveryAgent } from '../../lib/admin-queries.js';
import type { AdminSelection } from '../../lib/shell-sections.js';

type PaneId = 'overview' | 'agents' | 'users' | 'organizations';

const TARGET: Record<PaneId, Selection> = {
  overview: { kind: 'admin' },
  agents: { kind: 'admin-agents' },
  users: { kind: 'admin-users' },
  organizations: { kind: 'admin-organizations' },
};

const PANE_OF: Record<AdminSelection['kind'], PaneId> = {
  admin: 'overview',
  'admin-agents': 'agents',
  'admin-users': 'users',
  'admin-user': 'users',
  'admin-organizations': 'organizations',
  'admin-organization': 'organizations',
};

function Count({ value }: { value: number | undefined }): ReactNode {
  if (value === undefined) return null;
  return (
    <Text size="xs" color="secondary">
      {String(value)}
    </Text>
  );
}

interface RowProps {
  id: PaneId;
  title: string;
  line: string;
  icon: IconName;
  count?: number;
  active: PaneId;
}

function PaneRow({ id, title, line, icon, count, active }: RowProps): ReactNode {
  return <ListPaneRow title={title} line={line} avatar={<IconMark icon={icon} />} trailing={<Count value={count} />} selected={id === active} href={routeHash(TARGET[id])} />;
}

export function AdminPane({ selection }: { selection: AdminSelection }): ReactNode {
  const users = useAdminUsers().data;
  const organizations = useAdminOrganizations().data;
  const agents = useEveryAgent().data;
  const active = PANE_OF[selection.kind];
  const waiting = users?.filter((user) => user.status === 'waitlist').length ?? 0;
  return (
    <ListPane title="Admin">
      <Column>
        <PaneRow id="overview" title="Overview" line="Totals and sign-ups" icon="viewGrid" active={active} />
        <PaneRow id="agents" title="Agents" line="Status, model and version" icon="robot" count={agents?.length} active={active} />
        <PaneRow id="users" title="Users" line={waiting === 0 ? 'Everyone who signed in' : `${String(waiting)} waiting for you`} icon="users" count={users?.length} active={active} />
        <PaneRow id="organizations" title="Organizations" line="Agents and members" icon="officeBuilding" count={organizations?.length} active={active} />
      </Column>
    </ListPane>
  );
}
