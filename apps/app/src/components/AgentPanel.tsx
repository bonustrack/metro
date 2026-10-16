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
import { AgentDeepPage } from './agent/AgentDeepPage.js';
import { AddChatPage } from './AddChatPage.js';
import { GitHubSourcePage } from './GitHubSourcePage.js';
import { LaunchLogPage } from './LaunchLogPage.js';
import { BackupPage } from './settings/BackupPage.js';
import { ProfilePage } from './settings/ProfilePage.js';
import { RecentUsePage } from './tools/KeyModals.js';
import { agentPageOf } from '../lib/agent-tabs.js';

function toolsPage(project: string, selection: Selection): ReactNode {
  if (selection.kind === 'tools') return <ToolsPage project={project} connector={selection.connector ?? null} />;
  if (selection.kind === 'scheduled') return <ToolsPage project={project} focus="routines" />;
  if (selection.kind === 'secrets') return <ToolsPage project={project} focus="secret-keys" />;
  return null;
}

function claudeRoutes(project: string, selection: Selection): ReactNode {
  if (selection.kind === 'sessions') return <Sessions project={project} claudeProject={selection.claudeProject} id={selection.id} />;
  if (selection.kind === 'memory') return <Memory project={project} claudeProject={selection.claudeProject} file={selection.file} />;
  if (selection.kind === 'files') return <Files project={project} path={selection.path} />;
  if (selection.kind === 'scheduled-job') return <RoutinePage project={project} id={selection.id} />;
  if (selection.kind === 'skills') return <Skills project={project} />;
  if (selection.kind === 'skill') return <SkillPage project={project} id={selection.id} />;
  return null;
}

function settingsPage(project: string, selection: Selection): ReactNode {
  if (selection.kind === 'model') return <ModelRoutePage project={project} />;
  if (selection.kind === 'server') return <ServerDetails />;
  if (selection.kind === 'claude') return <ClaudeSettings project={project} />;
  return null;
}

function SettingsPage({ project, selection, children }: { project: string; selection: Selection; children: ReactNode }): ReactNode {
  const title = agentPageOf(selection.kind)?.label ?? 'Settings';
  return (
    <AgentDeepPage project={project} tab="settings" trail={[{ label: title }]} title={title}>
      {children}
    </AgentDeepPage>
  );
}

function replacedDialog(project: string, selection: Selection): ReactNode {
  if (selection.kind === 'add-chat') return <AddChatPage project={project} station={selection.station} />;
  if (selection.kind === 'backup') return <BackupPage project={project} />;
  if (selection.kind === 'agent-profile') return <ProfilePage project={project} />;
  if (selection.kind === 'launch-log') return <LaunchLogPage project={project} />;
  if (selection.kind === 'skills-github') return <GitHubSourcePage project={project} />;
  if (selection.kind === 'secrets-recent') return <RecentUsePage project={project} />;
  return null;
}

function ScopedPanel({ project, selection }: { project: string; selection: Selection }): ReactNode {
  const tools = toolsPage(project, selection);
  if (tools !== null) return tools;
  const claude = claudeRoutes(project, selection);
  if (claude !== null) return claude;
  const settings = settingsPage(project, selection);
  if (settings !== null) return <SettingsPage project={project} selection={selection}>{settings}</SettingsPage>;
  const replaced = replacedDialog(project, selection);
  if (replaced !== null) return replaced;
  if (selection.kind === 'run') return <RunPage key={project} project={project} view={selection.view} id={selection.id} />;
  if (selection.kind === 'agent-settings') return <AgentSettings project={project} />;
  if (selection.kind === 'voice') return <VoicePage project={project} />;
  if (selection.kind === 'chats') return <ChatsPage project={project} />;
  if (selection.kind === 'station') return <ChannelPage project={project} accountId={selection.accountId} rule={selection.rule} />;
  return <Home project={project} />;
}

export function AgentPanel({ selection }: { selection: Selection }): ReactNode {
  if (!('project' in selection)) return null;
  return <ScopedPanel project={selection.project} selection={selection} />;
}
