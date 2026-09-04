import { type ReactNode } from 'react';
import { deleteConnector } from '../api/connectors';
import { ConnectorPage } from './ConnectorPage';
import { Connectors } from './Connectors';
import { Docs } from './Docs';
import { Home } from './Home';
import { Memory } from './Memory';
import { Sessions } from './Sessions';
import { Settings } from './Settings';
import { StationPage } from './StationPage';
import { Stations } from './Stations';
import { type Selection } from './selection';

interface AgentPanelProps {
  token: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

interface ScopedProps extends AgentPanelProps {
  project: string;
}

type Go = (next: Selection) => void;

function connectorRoutes(token: string, project: string, selection: Selection, go: Go): ReactNode {
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

function claudeRoutes(token: string, project: string, selection: Selection, go: Go): ReactNode {
  if (selection.kind === 'sessions')
    return <Sessions token={token} project={project} claudeProject={selection.claudeProject} id={selection.id} onSelect={go} />;
  if (selection.kind === 'memory')
    return <Memory token={token} project={project} claudeProject={selection.claudeProject} file={selection.file} onSelect={go} />;
  return null;
}

function ScopedPanel({ token, project, selection, onSelect }: ScopedProps): ReactNode {
  const go: Go = (next) => {
    onSelect(next);
  };
  const connector = connectorRoutes(token, project, selection, go);
  if (connector !== null) return connector;
  const claude = claudeRoutes(token, project, selection, go);
  if (claude !== null) return claude;
  if (selection.kind === 'stations')
    return (
      <Stations
        token={token}
        project={project}
        onOpen={(accountId) => {
          go({ kind: 'station', project, accountId });
        }}
      />
    );
  if (selection.kind === 'station')
    return (
      <StationPage
        token={token}
        project={project}
        accountId={selection.accountId}
        onOpenAgent={() => {
          go({ kind: 'home', project });
        }}
      />
    );
  return <Home token={token} project={project} onSelect={go} />;
}

export function AgentPanel(props: AgentPanelProps): ReactNode {
  const { selection } = props;
  if (selection.kind === 'docs') return <Docs />;
  if (selection.kind === 'settings') return <Settings />;
  if (!('project' in selection)) return null;
  return <ScopedPanel {...props} project={selection.project} />;
}
