import { type ReactNode } from 'react';
import { type Selection } from '@metro-labs/client/selection';
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
import { ChannelPage } from './chats/ChannelPage.js';
import { ChatsPage } from './chats/ChatsPage.js';
import { Files } from './Files.js';
import { VoicePage } from './VoicePage.js';
import { RoutinePage } from './tools/RoutinePage.js';
import { ToolsPage } from './tools/ToolsPage.js';

const TOOLS_PAGES = new Set<Selection['kind']>(['tools', 'scheduled', 'secrets']);

function claudeRoutes(project: string, selection: Selection): ReactNode {
  if (selection.kind === 'sessions') return <Sessions project={project} claudeProject={selection.claudeProject} id={selection.id} />;
  if (selection.kind === 'memory') return <Memory project={project} claudeProject={selection.claudeProject} file={selection.file} />;
  if (selection.kind === 'claude') return <ClaudeSettings project={project} />;
  if (selection.kind === 'files') return <Files project={project} path={selection.path} />;
  if (selection.kind === 'scheduled-job') return <RoutinePage project={project} id={selection.id} />;
  if (selection.kind === 'skills') return <Skills project={project} />;
  if (selection.kind === 'skill') return <SkillPage project={project} id={selection.id} />;
  return null;
}

function ScopedPanel({ project, selection }: { project: string; selection: Selection }): ReactNode {
  if (TOOLS_PAGES.has(selection.kind)) return <ToolsPage project={project} />;
  const claude = claudeRoutes(project, selection);
  if (claude !== null) return claude;
  if (selection.kind === 'run') return <RunPage key={project} project={project} />;
  if (selection.kind === 'server') return <ServerDetails />;
  if (selection.kind === 'agent-settings') return <AgentSettings project={project} />;
  if (selection.kind === 'model') return <ModelRoutePage />;
  if (selection.kind === 'voice') return <VoicePage project={project} />;
  if (selection.kind === 'chats') return <ChatsPage project={project} />;
  if (selection.kind === 'station') return <ChannelPage project={project} accountId={selection.accountId} rule={selection.rule} />;
  return <Home project={project} />;
}

export function AgentPanel({ selection }: { selection: Selection }): ReactNode {
  if (!('project' in selection)) return null;
  return <ScopedPanel project={selection.project} selection={selection} />;
}
