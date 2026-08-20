import { type ReactNode, useEffect, useState } from 'react';
import {
  createAgent,
  deleteAgent,
  type CreatedAgent,
  type Dashboard as DashboardData,
} from '../api/client';
import {
  applyRoute,
  currentSelection,
  routeHash,
  subscribeRoute,
} from '../route';
import { findAccount } from '../api/accounts';
import { detachAccount } from '../api/attach';
import { AgentPanel } from './AgentPanel';
import { AgentSidebar } from './AgentSidebar';
import { CreateAgent } from './CreateAgent';
import { Shell } from './Shell';
import { type Selection } from './selection';
import { useIsNarrow } from '../media';
import { useDocumentTitle } from '../title';

interface DashboardProps {
  token: string;
  data: DashboardData;
  onRefresh: (dropped?: string[]) => void;
  onLock: () => void;
}


function pageName(selection: Selection, data: DashboardData): string {
  if (selection.kind === 'settings') return 'Settings';
  if (selection.kind === 'docs') return 'Documentation';
  if (selection.kind === 'station')
    return findAccount(data.groups, selection.accountId) === undefined
      ? 'Station'
      : selection.accountId;
  if (selection.kind === 'agent')
    return data.agents.find((a) => a.id === selection.id)?.name ?? 'Agent';
  return 'Agents';
}

function sidebarSelection(
  selection: Selection,
  data: DashboardData,
): Selection {
  if (selection.kind !== 'station') return selection;
  const owner = findAccount(data.groups, selection.accountId)?.row.agentId;
  return owner === null || owner === undefined
    ? selection
    : { kind: 'agent', id: owner };
}

interface ActionDeps {
  token: string;
  data: DashboardData;
  created: CreatedAgent | null;
  setCreated: (created: CreatedAgent | null) => void;
  setPicked: (selection: Selection) => void;
  select: (selection: Selection) => void;
  onRefresh: (dropped?: string[]) => void;
}

interface Actions {
  create: (name: string) => Promise<void>;
  detach: (station: string, accountId: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

function makeActions(d: ActionDeps): Actions {
  return {
    create: async (name) => {
      const agent = await createAgent(d.token, name);
      d.setCreated(agent);
      d.select({ kind: 'agent', id: agent.id });
      d.onRefresh();
    },
    detach: async (station, accountId) => {
      const owner = findAccount(d.data.groups, accountId)?.row.agentId;
      if (owner === null || owner === undefined) return;
      await detachAccount(d.token, owner, station, accountId);
      d.setPicked({ kind: 'agent', id: owner });
      d.onRefresh([`${station}/${accountId}`]);
    },
    remove: async (id) => {
      await deleteAgent(d.token, id);
      if (d.created?.id === id) d.setCreated(null);
      d.setPicked({ kind: 'none' });
      d.onRefresh();
    },
  };
}

export function Dashboard({
  token,
  data,
  onRefresh,
  onLock,
}: DashboardProps): ReactNode {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [picked, setPicked] = useState<Selection>(currentSelection);

  const selection: Selection = picked;
  const hash = routeHash(selection);
  useDocumentTitle(pageName(selection, data));

  useEffect(() => subscribeRoute(setPicked), []);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  useEffect(() => {
    applyRoute(selection, true);
  }, [hash]);

  const onSelect = (next: Selection): void => {
    setMenuOpen(false);
    setPicked(next);
    applyRoute(next, false);
  };

  const actions = makeActions({
    token,
    data,
    created,
    setCreated,
    setPicked,
    select: onSelect,
    onRefresh,
  });

  return (
    <Shell
      narrow={narrow}
      menuOpen={menuOpen}
      onOpenMenu={() => {
        setMenuOpen(true);
      }}
      onCloseMenu={() => {
        setMenuOpen(false);
      }}
      sidebar={
        <AgentSidebar
          agents={data.agents}
          groups={data.groups}
          selection={sidebarSelection(selection, data)}
          email={data.email}
          onSelect={onSelect}
          onLock={onLock}
        />
      }
    >
      <AgentPanel
        token={token}
        agents={data.agents}
        groups={data.groups}
        attachable={data.attachable}
        unattributed={data.unattributed}
        selection={selection}
        created={created}
        capabilities={data.capabilities}
        onNew={() => {
          setCreating(true);
        }}
        onOpen={(id) => {
          onSelect({ kind: 'agent', id });
        }}
        onOpenStation={(accountId) => {
          onSelect({ kind: 'station', accountId });
        }}
        onDetach={actions.detach}
        onDismiss={() => {
          setCreated(null);
        }}
        onChanged={onRefresh}
        onDelete={actions.remove}
      />
      <CreateAgent
        open={creating}
        first={data.agents.length === 0}
        onClose={() => {
          setCreating(false);
        }}
        onCreate={actions.create}
      />
    </Shell>
  );
}
