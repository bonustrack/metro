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


function pageName(selection: Selection, agents: DashboardData['agents']): string {
  if (selection.kind === 'settings') return 'Settings';
  if (selection.kind === 'docs') return 'Documentation';
  if (selection.kind === 'agent')
    return agents.find((a) => a.id === selection.id)?.name ?? 'Agent';
  return 'Agents';
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
  useDocumentTitle(pageName(selection, data.agents));

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

  const onCreate = async (name: string): Promise<void> => {
    const agent = await createAgent(token, name);
    setCreated(agent);
    onSelect({ kind: 'agent', id: agent.id });
    onRefresh();
  };

  const onDelete = async (id: number): Promise<void> => {
    await deleteAgent(token, id);
    if (created?.id === id) setCreated(null);
    setPicked({ kind: 'none' });
    onRefresh();
  };

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
          selection={selection}
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
        onNew={() => {
          setCreating(true);
        }}
        onOpen={(id) => {
          onSelect({ kind: 'agent', id });
        }}
        onDismiss={() => {
          setCreated(null);
        }}
        onChanged={onRefresh}
        onDelete={onDelete}
      />
      <CreateAgent
        open={creating}
        first={data.agents.length === 0}
        onClose={() => {
          setCreating(false);
        }}
        onCreate={onCreate}
      />
    </Shell>
  );
}
