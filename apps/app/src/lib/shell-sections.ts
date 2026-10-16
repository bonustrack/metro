import type { Selection } from '@metro-labs/client/selection';

type Kind = Selection['kind'];

export type ShellSectionId = 'agents' | 'connectors' | 'models' | 'organization';

export interface ShellSection {
  id: ShellSectionId;
  label: string;
  target: Selection;
}

export const SHELL_SECTIONS: readonly ShellSection[] = [
  { id: 'agents', label: 'Agents', target: { kind: 'servers' } },
  { id: 'connectors', label: 'Connectors', target: { kind: 'org-connectors' } },
  { id: 'models', label: 'Models', target: { kind: 'org-models' } },
  { id: 'organization', label: 'Organization', target: { kind: 'organization' } },
];

const SECTION_OF: Partial<Record<Kind, ShellSectionId>> = {
  servers: 'agents',
  none: 'agents',
  'org-connectors': 'connectors',
  'org-connector': 'connectors',
  'org-connector-new': 'connectors',
  'org-models': 'models',
  'org-route': 'models',
  'org-model': 'models',
  'org-model-add': 'models',
  'org-model-sign-in': 'models',
  'org-aws': 'organization',
  organization: 'organization',
  members: 'organization',
};

export type AdminSelection = Extract<Selection, { kind: 'admin' | 'admin-users' | 'admin-organizations' | 'admin-agents' | 'admin-user' | 'admin-organization' }>;

const ADMIN_KINDS = new Set<Kind>(['admin', 'admin-users', 'admin-organizations', 'admin-agents', 'admin-user', 'admin-organization']);

export const isAdminSelection = (s: Selection): s is AdminSelection => ADMIN_KINDS.has(s.kind);

const TAB_ROOTS = new Set<Kind>(['servers', 'none', 'org-connectors', 'org-models', 'organization', 'members']);

export function shellSectionOf(selection: Selection): ShellSectionId | null {
  if ('project' in selection) return 'agents';
  return SECTION_OF[selection.kind] ?? null;
}

export const phoneTabOf = (selection: Selection): ShellSectionId => shellSectionOf(selection) ?? 'organization';

export const isTabRoot = (selection: Selection): boolean => TAB_ROOTS.has(selection.kind);

export function phoneBackOf(selection: Selection): Selection | null {
  if (isTabRoot(selection) || isAdminSelection(selection)) return null;
  if ('project' in selection) return { kind: 'servers' };
  if (selection.kind === 'org-connector') return selection.agent === undefined ? { kind: 'org-connectors' } : null;
  if (selection.kind === 'org-model-sign-in') return { kind: 'org-model', id: selection.id };
  if (selection.kind === 'org-route' || selection.kind === 'org-model' || selection.kind === 'org-model-add') return { kind: 'org-models' };
  return { kind: 'organization' };
}
