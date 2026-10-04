import { type ReactNode } from 'react';
import { deleteConnector } from '@metro-labs/client/api/connectors';
import { type Selection } from '@metro-labs/client/selection';
import { ConnectorPage } from './ConnectorPage.js';
import { Connectors } from './Connectors.js';
import { Home } from './Home.js';
import { Memory } from './Memory.js';
import { Sessions } from './Sessions.js';
import { ServerPage } from './ServerPage.js';
import { AgentSettings } from './AgentSettings.js';
import { ModelPage } from './ModelPage.js';
import { ClaudeSettings } from './ClaudeSettings.js';
import { Skills } from './Skills.js';
import { SkillPage } from './SkillPage.js';
import { Settings } from './Settings.js';
import { StationPage } from './StationPage.js';
import { Stations } from './Stations.js';
import { ScheduledJobs } from './ScheduledJobs.js';
import { ScheduledJobPage } from './ScheduledJobPage.js';
import { Files } from './Files.js';
import { Secrets } from './Secrets.js';
import { VoicePage } from './VoicePage.js';
import { SectionTabs } from './SectionTabs.js';
import { sectionOf } from './sections.js';
import { Tabbed } from './tabbed.js';
import { go } from '../lib/nav.js';

function connectorRoutes(project: string, selection: Selection): ReactNode {
  if (selection.kind === 'connectors') return <Connectors project={project} />;
  if (selection.kind === 'connector')
    return (
      <ConnectorPage
        project={project}
        id={selection.id}
        onDelete={async (id) => {
          await deleteConnector(id);
          go({ kind: 'connectors', project });
        }}
      />
    );
  return null;
}

function claudeRoutes(project: string, selection: Selection): ReactNode {
  if (selection.kind === 'sessions') return <Sessions project={project} claudeProject={selection.claudeProject} id={selection.id} />;
  if (selection.kind === 'memory') return <Memory project={project} claudeProject={selection.claudeProject} file={selection.file} />;
  if (selection.kind === 'claude') return <ClaudeSettings project={project} />;
  if (selection.kind === 'secrets') return <Secrets />;
  if (selection.kind === 'files') return <Files project={project} path={selection.path} />;
  if (selection.kind === 'scheduled') return <ScheduledJobs project={project} />;
  if (selection.kind === 'scheduled-job') return <ScheduledJobPage project={project} id={selection.id} />;
  if (selection.kind === 'skills') return <Skills project={project} />;
  if (selection.kind === 'skill') return <SkillPage project={project} id={selection.id} />;
  return null;
}

function ScopedPanel({ project, selection }: { project: string; selection: Selection }): ReactNode {
  const connector = connectorRoutes(project, selection);
  if (connector !== null) return connector;
  const claude = claudeRoutes(project, selection);
  if (claude !== null) return claude;
  if (selection.kind === 'server') return <ServerPage project={project} />;
  if (selection.kind === 'agent-settings') return <AgentSettings />;
  if (selection.kind === 'model') return <ModelPage />;
  if (selection.kind === 'voice') return <VoicePage />;
  if (selection.kind === 'stations') return <Stations project={project} />;
  if (selection.kind === 'station') return <StationPage project={project} accountId={selection.accountId} />;
  return <Home project={project} />;
}

export function AgentPanel({ selection }: { selection: Selection }): ReactNode {
  if (selection.kind === 'settings') return <Settings />;
  if (!('project' in selection)) return null;
  const tabbed = sectionOf(selection.kind)?.tabs !== undefined;
  return (
    <>
      <SectionTabs project={selection.project} selection={selection} />
      <Tabbed.Provider value={tabbed}>
        <ScopedPanel project={selection.project} selection={selection} />
      </Tabbed.Provider>
    </>
  );
}
