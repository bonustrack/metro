import { type ReactNode } from 'react';
import { type Selection } from '@metro-labs/client/selection';
import { Connectors } from './Connectors.js';
import { Home } from './Home.js';
import { RunPage } from './RunPage.js';
import { Memory } from './Memory.js';
import { Sessions } from './Sessions.js';
import { ServerDetails } from './settings/ServerDetails.js';
import { AgentSettings } from './settings/SettingsHome.js';
import { ModelRoutePage } from './settings/ModelRoutePage.js';
import { ClaudeSettings } from './ClaudeSettings.js';
import { Skills } from './Skills.js';
import { SkillPage } from './SkillPage.js';
import { StationPage } from './StationPage.js';
import { Stations } from './Stations.js';
import { ScheduledJobs } from './ScheduledJobs.js';
import { ScheduledJobPage } from './ScheduledJobPage.js';
import { Files } from './Files.js';
import { Secrets } from './Secrets.js';
import { VoicePage } from './VoicePage.js';

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
  if (selection.kind === 'tools') return <Connectors />;
  const claude = claudeRoutes(project, selection);
  if (claude !== null) return claude;
  if (selection.kind === 'run') return <RunPage key={project} />;
  if (selection.kind === 'server') return <ServerDetails />;
  if (selection.kind === 'agent-settings') return <AgentSettings project={project} />;
  if (selection.kind === 'model') return <ModelRoutePage />;
  if (selection.kind === 'voice') return <VoicePage />;
  if (selection.kind === 'chats') return <Stations project={project} />;
  if (selection.kind === 'station') return <StationPage project={project} accountId={selection.accountId} />;
  return <Home project={project} />;
}

export function AgentPanel({ selection }: { selection: Selection }): ReactNode {
  if (!('project' in selection)) return null;
  return <ScopedPanel project={selection.project} selection={selection} />;
}
