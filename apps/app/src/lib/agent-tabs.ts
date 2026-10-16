import type { Selection } from '@metro-labs/client/selection';

type Kind = Selection['kind'];

export type AgentTabId = 'home' | 'chats' | 'memory' | 'tools' | 'settings';

export interface AgentPage {
  label: string;
  kinds: readonly Kind[];
  target: (project: string) => Selection;
  newTab?: boolean;
}

export interface AgentTab {
  id: AgentTabId;
  label: string;
  target: (project: string) => Selection;
  pages: readonly AgentPage[];
}

const CHATS: AgentPage[] = [
  { label: 'Channels', kinds: ['chats', 'station'], target: (project) => ({ kind: 'chats', project }) },
  { label: 'Voice', kinds: ['voice'], target: (project) => ({ kind: 'voice', project }) },
  { label: 'Conversations', kinds: ['sessions'], target: (project) => ({ kind: 'sessions', project, claudeProject: null, id: null }) },
];

const MEMORY: AgentPage[] = [
  { label: 'Notes', kinds: ['memory'], target: (project) => ({ kind: 'memory', project, claudeProject: null, file: null }) },
  { label: 'Files', kinds: ['files'], target: (project) => ({ kind: 'files', project, path: '' }) },
  { label: 'Skills', kinds: ['skills', 'skill'], target: (project) => ({ kind: 'skills', project }) },
];

const TOOLS: AgentPage[] = [
  { label: 'Connectors', kinds: ['tools'], target: (project) => ({ kind: 'tools', project }) },
  { label: 'Scheduled tasks', kinds: ['scheduled', 'scheduled-job'], target: (project) => ({ kind: 'scheduled', project }) },
  { label: 'Secrets', kinds: ['secrets'], target: (project) => ({ kind: 'secrets', project }) },
];

const SETTINGS: AgentPage[] = [
  { label: 'General', kinds: ['agent-settings'], target: (project) => ({ kind: 'agent-settings', project }) },
  { label: 'Model', kinds: ['model'], target: (project) => ({ kind: 'model', project }) },
  { label: 'Harness', kinds: ['claude'], target: (project) => ({ kind: 'claude', project }) },
  { label: 'Server', kinds: ['server'], target: (project) => ({ kind: 'server', project }) },
  { label: 'Terminal', kinds: ['terminal'], target: (project) => ({ kind: 'terminal', project }), newTab: true },
  { label: 'Run', kinds: ['run'], target: (project) => ({ kind: 'run', project }) },
];

const HOME: AgentTab = { id: 'home', label: 'Home', target: (project) => ({ kind: 'home', project }), pages: [] };

export const AGENT_TABS: readonly AgentTab[] = [
  HOME,
  { id: 'chats', label: 'Chats', target: (project) => ({ kind: 'chats', project }), pages: CHATS },
  { id: 'memory', label: 'Memory', target: (project) => ({ kind: 'memory', project, claudeProject: null, file: null }), pages: MEMORY },
  { id: 'tools', label: 'Tools', target: (project) => ({ kind: 'tools', project }), pages: TOOLS },
  { id: 'settings', label: 'Settings', target: (project) => ({ kind: 'agent-settings', project }), pages: SETTINGS },
];

export function agentTabOf(kind: Kind): AgentTab {
  return AGENT_TABS.find((tab) => tab.pages.some((page) => page.kinds.includes(kind))) ?? HOME;
}

export function agentPageOf(kind: Kind): AgentPage | undefined {
  return agentTabOf(kind).pages.find((page) => page.kinds.includes(kind));
}

export function isPageRoot(selection: Selection): boolean {
  if (!('project' in selection)) return false;
  const page = agentPageOf(selection.kind);
  return page !== undefined && page.target(selection.project).kind === selection.kind;
}
