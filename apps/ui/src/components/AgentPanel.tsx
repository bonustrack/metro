import { type ReactNode } from 'react';
import { AgentPage } from './AgentPage';
import { AgentsHome } from './AgentsHome';
import { deleteConnector } from '../api/connectors';
import { ConnectorPage } from './ConnectorPage';
import { Connectors } from './Connectors';
import { Docs } from './Docs';
import { CollectionPage } from './CollectionPage';
import { Collections } from './Collections';
import { Members } from './Members';
import { ProjectSettings } from './ProjectSettings';
import { Settings } from './Settings';
import { StationPage } from './StationPage';
import { type Selection } from './selection';

interface AgentPanelProps {
  token: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

interface ScopedProps extends AgentPanelProps {
  project: string;
}


function connectorRoutes(
  token: string,
  project: string,
  selection: Selection,
  go: (next: Selection) => void,
): ReactNode {
  if (selection.kind === 'collections')
    return (
      <Collections
        token={token}
        project={project}
        onOpen={(id) => {
          go({ kind: 'collection', project, id });
        }}
      />
    );
  if (selection.kind === 'collection')
    return (
      <CollectionPage
        token={token}
        project={project}
        id={selection.id}
        onBack={() => {
          go({ kind: 'collections', project });
        }}
        onGone={() => {
          go({ kind: 'collections', project });
        }}
      />
    );
  if (selection.kind === 'connectors')
    return (
      <Connectors
        token={token}
        project={project}
        onOpen={(id) => {
          go({ kind: 'connector', project, id });
        }}
      />
    );
  if (selection.kind === 'connector')
    return (
      <ConnectorPage
        token={token}
        project={project}
        id={selection.id}
        onDelete={async (id) => {
          await deleteConnector(token, id);
          go({ kind: 'connectors', project });
        }}
        onBack={() => {
          go({ kind: 'connectors', project });
        }}
      />
    );
  return null;
}

function ScopedPanel({
  token,
  project,
  selection,
  onSelect,
}: ScopedProps): ReactNode {
  const go = (next: Selection): void => {
    onSelect(next);
  };
  if (selection.kind === 'members')
    return <Members token={token} project={project} />;
  if (selection.kind === 'project')
    return (
      <ProjectSettings
        token={token}
        project={project}
        onGone={() => {
          go({ kind: 'none' });
        }}
      />
    );
  const scoped = connectorRoutes(token, project, selection, go);
  if (scoped !== null) return scoped;
  if (selection.kind === 'station')
    return (
      <StationPage
        token={token}
        project={project}
        accountId={selection.accountId}
        onOpenAgent={(id) => {
          go({ kind: 'agent', project, id });
        }}
      />
    );
  if (selection.kind === 'agent')
    return (
      <AgentPage
        token={token}
        project={project}
        id={selection.id}
        onOpenStation={(accountId) => {
          go({ kind: 'station', project, accountId });
        }}
        onGone={() => {
          go({ kind: 'agents', project });
        }}
        onBack={() => {
          go({ kind: 'agents', project });
        }}
      />
    );
  return (
    <AgentsHome
      token={token}
      project={project}
      onOpen={(id) => {
        go({ kind: 'agent', project, id });
      }}
    />
  );
}

export function AgentPanel(props: AgentPanelProps): ReactNode {
  const { selection } = props;
  if (selection.kind === 'docs') return <Docs />;
  if (selection.kind === 'settings') return <Settings />;
  if (!('project' in selection)) return null;
  return <ScopedPanel {...props} project={selection.project} />;
}
