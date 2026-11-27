import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import type { Selection } from '@metro-labs/client/selection';

type Kind = Selection['kind'];

export type ShellSectionId = 'agents' | 'chats' | 'connectors' | 'models' | 'organization';

export interface ShellSection {
  id: ShellSectionId;
  label: string;
  target: Selection;
}

export const SHELL_SECTIONS: readonly ShellSection[] = [
  { id: 'chats', label: 'Chats', target: { kind: 'chat-home' } },
  { id: 'agents', label: 'Agents', target: { kind: 'servers' } },
  { id: 'connectors', label: 'Connectors', target: { kind: 'org-connectors' } },
  { id: 'models', label: 'Gateway', target: { kind: 'org-models' } },
  { id: 'organization', label: 'Organization', target: { kind: 'organization' } },
];

const SECTION_OF: Partial<Record<Kind, ShellSectionId>> = {
  servers: 'agents',
  none: 'agents',
  activity: 'connectors',
  'org-connectors': 'connectors',
  'org-connector': 'connectors',
  'org-connector-new': 'connectors',
  'org-models': 'models',
  'org-route': 'models',
  'org-usage': 'models',
  'org-model': 'models',
  'org-model-add': 'models',
  'org-model-sign-in': 'models',
  'org-aws': 'organization',
  'app-connect': 'agents',
  'chat-home': 'chats',
  'chat-new': 'chats',
  chat: 'chats',
  organization: 'organization',
  members: 'organization',
};

export type AdminSelection = Extract<Selection, { kind: 'admin' | 'admin-users' | 'admin-organizations' | 'admin-agents' | 'admin-user' | 'admin-organization' }>;

const ADMIN_KINDS = new Set<Kind>(['admin', 'admin-users', 'admin-organizations', 'admin-agents', 'admin-user', 'admin-organization']);

export const isAdminSelection = (s: Selection): s is AdminSelection => ADMIN_KINDS.has(s.kind);

const TAB_ROOTS = new Set<Kind>(['servers', 'none', 'chat-home', 'org-connectors', 'org-models', 'organization', 'members']);

export function shellSectionOf(selection: Selection): ShellSectionId | null {
  if ('project' in selection) return 'agents';
  return SECTION_OF[selection.kind] ?? null;
}

export const phoneTabOf = (selection: Selection): ShellSectionId => shellSectionOf(selection) ?? 'organization';

export const isTabRoot = (selection: Selection): boolean => TAB_ROOTS.has(selection.kind);

const BACK_TO: Partial<Record<Kind, Selection>> = {
  'org-route': { kind: 'org-models' },
  'org-usage': { kind: 'org-models' },
  'org-model': { kind: 'org-models' },
  'org-model-add': { kind: 'org-models' },
  chat: { kind: 'chat-home' },
  'chat-new': { kind: 'chat-home' },
};

export function phoneBackOf(selection: Selection): Selection | null {
  if (isTabRoot(selection) || isAdminSelection(selection)) return null;
  if ('project' in selection) return { kind: 'servers' };
  if (selection.kind === 'org-connector') return selection.agent === undefined ? { kind: 'org-connectors' } : null;
  if (selection.kind === 'org-model-sign-in') return { kind: 'org-model', id: selection.id };
  if (selection.kind === 'activity') return selection.agent === undefined ? { kind: 'org-connectors' } : { kind: 'home', project: selection.agent };
  const back = BACK_TO[selection.kind];
  return back === undefined ? { kind: 'organization' } : { ...back };
}

export function phoneBackLabel(back: Selection, servers: readonly Server[] | undefined): string {
  const section = SHELL_SECTIONS.find((s) => s.target.kind === back.kind);
  if (section !== undefined) return section.label;
  const server = 'project' in back ? servers?.find((s) => s.id === back.project) : undefined;
  return server === undefined ? 'Back' : serverLabel(server);
}
