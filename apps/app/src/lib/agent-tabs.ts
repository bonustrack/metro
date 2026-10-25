import type { Selection } from '@metro-labs/client/selection';

type Kind = Selection['kind'];

export type AgentTabId = 'home' | 'chats' | 'memory' | 'tools' | 'scheduled' | 'settings';

export interface AgentPage {
  label: string;
  kinds: readonly Kind[];
  target: (project: string) => Selection;
  newTab?: boolean;
  deep?: boolean;
}

export interface AgentTab {
  id: AgentTabId;
  label: string;
  target: (project: string) => Selection;
  pages: readonly AgentPage[];
}

const chats = (project: string): Selection => ({ kind: 'chats', project });
const notes = (project: string): Selection => ({ kind: 'memory', project, claudeProject: null, file: null });
const tools = (project: string): Selection => ({ kind: 'tools', project });
const scheduled = (project: string): Selection => ({ kind: 'scheduled', project });
const settings = (project: string): Selection => ({ kind: 'agent-settings', project });

const HOME_PAGES: AgentPage[] = [{ label: 'Right now', kinds: ['run'], target: (project) => ({ kind: 'run', project }), deep: true }];

const CHATS: AgentPage[] = [
  { label: 'Channels', kinds: ['chats'], target: chats },
  { label: 'Channel', kinds: ['station'], target: chats, deep: true },
  { label: 'Voice calls', kinds: ['voice'], target: (project) => ({ kind: 'voice', project }), deep: true },
  { label: 'Conversations', kinds: ['sessions'], target: (project) => ({ kind: 'sessions', project, claudeProject: null, id: null }), deep: true },
  { label: 'Add a chat', kinds: ['add-chat'], target: (project) => ({ kind: 'add-chat', project }), deep: true },
];

const MEMORY: AgentPage[] = [
  { label: 'Notes', kinds: ['memory'], target: notes },
  { label: 'Files', kinds: ['files'], target: (project) => ({ kind: 'files', project, path: '' }) },
  { label: 'Skills', kinds: ['skills'], target: (project) => ({ kind: 'skills', project }) },
  { label: 'Skill', kinds: ['skill'], target: (project) => ({ kind: 'skills', project }), deep: true },
  { label: 'GitHub skills', kinds: ['skills-github'], target: (project) => ({ kind: 'skills-github', project }), deep: true },
];

const CONNECTORS: AgentPage[] = [
  { label: 'Connectors', kinds: ['tools'], target: tools },
];

const SCHEDULED: AgentPage[] = [
  { label: 'Scheduled', kinds: ['scheduled'], target: scheduled },
  { label: 'Routine', kinds: ['scheduled-job'], target: scheduled, deep: true },
];

const SETTINGS: AgentPage[] = [
  { label: 'Settings', kinds: ['agent-settings'], target: settings },
  { label: 'Gateway', kinds: ['model'], target: (project) => ({ kind: 'model', project }), deep: true },
  { label: 'Agent SDK setup', kinds: ['claude'], target: (project) => ({ kind: 'claude', project }), deep: true },
  { label: 'Server', kinds: ['server'], target: (project) => ({ kind: 'server', project }), deep: true },
  { label: 'Profile', kinds: ['agent-profile'], target: (project) => ({ kind: 'agent-profile', project }), deep: true },
  { label: 'Backup', kinds: ['backup'], target: (project) => ({ kind: 'backup', project }), deep: true },
  { label: 'Launch log', kinds: ['launch-log'], target: (project) => ({ kind: 'launch-log', project }), deep: true },
  { label: 'Terminal', kinds: ['terminal'], target: (project) => ({ kind: 'terminal', project }), newTab: true, deep: true },
];

const HOME: AgentTab = { id: 'home', label: 'Home', target: (project) => ({ kind: 'home', project }), pages: HOME_PAGES };

export const AGENT_TABS: readonly AgentTab[] = [
  HOME,
  { id: 'chats', label: 'Channels', target: chats, pages: CHATS },
  { id: 'memory', label: 'Memory', target: notes, pages: MEMORY },
  { id: 'tools', label: 'Connectors', target: tools, pages: CONNECTORS },
  { id: 'scheduled', label: 'Scheduled', target: scheduled, pages: SCHEDULED },
  { id: 'settings', label: 'Settings', target: settings, pages: SETTINGS },
];

export const agentTab = (id: AgentTabId): AgentTab => AGENT_TABS.find((tab) => tab.id === id) ?? HOME;

export function agentTabOf(kind: Kind): AgentTab {
  return AGENT_TABS.find((tab) => tab.pages.some((page) => page.kinds.includes(kind))) ?? HOME;
}

export function agentPageOf(kind: Kind): AgentPage | undefined {
  return agentTabOf(kind).pages.find((page) => page.kinds.includes(kind));
}

export const isNoteFile = (path: string | null): path is string => path?.endsWith('.md') === true;

export function isDeepPage(selection: Selection): boolean {
  if (selection.kind === 'memory') return isNoteFile(selection.file);
  if (selection.kind === 'tools') return selection.connector !== undefined;
  return 'project' in selection && agentPageOf(selection.kind)?.deep === true;
}

export function isPageRoot(selection: Selection): boolean {
  if (!('project' in selection)) return false;
  const page = agentPageOf(selection.kind);
  return page !== undefined && page.deep !== true && page.target(selection.project).kind === selection.kind;
}

export const shallowPages = (tab: AgentTab): AgentPage[] => tab.pages.filter((page) => page.deep !== true);
