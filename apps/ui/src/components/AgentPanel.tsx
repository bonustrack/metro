import { type ReactNode } from 'react';
import { deleteConnector } from '../api/connectors.js';
import { ConnectorPage } from './ConnectorPage.js';
import { Connectors } from './Connectors.js';
import { Docs } from './Docs.js';
import { Home } from './Home.js';
import { Memory } from './Memory.js';
import { Sessions } from './Sessions.js';
import { ServerPage } from './ServerPage.js';
import { TerminalPage } from './Terminal.js';
import { ModelPage } from './ModelPage.js';
import { ClaudeSettings } from './ClaudeSettings.js';
import { Settings } from './Settings.js';
import { StationPage } from './StationPage.js';
import { Stations } from './Stations.js';
import { type Selection } from './selection.js';

interface AgentPanelProps {
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

interface ScopedProps extends AgentPanelProps {
  project: string;
}

type Go = (next: Selection) => void;

function connectorRoutes(project: string, selection: Selection, go: Go): ReactNode {
  if (selection.kind === 'connectors')
    return (
      <Connectors
        project={project}
        onOpen={(id) => {
          go({ kind: 'connector', project, id });
        }}
      />
    );
  if (selection.kind === 'connector')
    return (
      <ConnectorPage
        project={project}
        id={selection.id}
        onDelete={async (id) => {
          await deleteConnector(id);
          go({ kind: 'connectors', project });
        }}
        onBack={() => {
          go({ kind: 'connectors', project });
        }}
      />
    );
  return null;
}

function claudeRoutes(project: string, selection: Selection, go: Go): ReactNode {
  if (selection.kind === 'sessions')
    return <Sessions project={project} claudeProject={selection.claudeProject} id={selection.id} onSelect={go} />;
  if (selection.kind === 'memory')
    return <Memory project={project} claudeProject={selection.claudeProject} file={selection.file} onSelect={go} />;
  if (selection.kind === 'claude') return <ClaudeSettings />;
  return null;
}

function ScopedPanel({ project, selection, onSelect }: ScopedProps): ReactNode {
  const go: Go = (next) => {
    onSelect(next);
  };
  const connector = connectorRoutes(project, selection, go);
  if (connector !== null) return connector;
  const claude = claudeRoutes(project, selection, go);
  if (claude !== null) return claude;
  if (selection.kind === 'server') return <ServerPage project={project} />;
  if (selection.kind === 'terminal') return <TerminalPage />;
  if (selection.kind === 'model') return <ModelPage />;
  if (selection.kind === 'stations')
    return (
      <Stations
        project={project}
        onOpen={(accountId) => {
          go({ kind: 'station', project, accountId });
        }}
      />
    );
  if (selection.kind === 'station')
    return (
      <StationPage
        project={project}
        accountId={selection.accountId}
        onOpenAgent={() => {
          go({ kind: 'home', project });
        }}
      />
    );
  return <Home project={project} onSelect={go} />;
}

export function AgentPanel(props: AgentPanelProps): ReactNode {
  const { selection } = props;
  if (selection.kind === 'docs') return <Docs />;
  if (selection.kind === 'settings') return <Settings />;
  if (!('project' in selection)) return null;
  return <ScopedPanel {...props} project={selection.project} />;
}
