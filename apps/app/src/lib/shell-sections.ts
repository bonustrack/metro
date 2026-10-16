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
  'org-models': 'models',
  'org-route': 'models',
  'org-model': 'models',
  organization: 'organization',
  members: 'organization',
};

export type AdminSelection = { kind: 'admin' } | { kind: 'admin-users' } | { kind: 'admin-organizations' } | { kind: 'admin-agents' };

const ADMIN_KINDS = new Set<Kind>(['admin', 'admin-users', 'admin-organizations', 'admin-agents']);

export const isAdminSelection = (s: Selection): s is AdminSelection => ADMIN_KINDS.has(s.kind);

const TAB_ROOTS = new Set<Kind>(['servers', 'none', 'org-connectors', 'org-models', 'organization', 'members']);

export function shellSectionOf(selection: Selection): ShellSectionId | null {
  if ('project' in selection) return 'agents';
  return SECTION_OF[selection.kind] ?? null;
}

export const phoneTabOf = (selection: Selection): ShellSectionId => shellSectionOf(selection) ?? 'organization';

export const isTabRoot = (selection: Selection): boolean => TAB_ROOTS.has(selection.kind);

export function phoneBackOf(selection: Selection): Selection | null {
  if (isTabRoot(selection)) return null;
  if ('project' in selection) return { kind: 'servers' };
  if (selection.kind === 'org-connector') return selection.agent === undefined ? { kind: 'org-connectors' } : null;
  if (selection.kind === 'org-route' || selection.kind === 'org-model') return { kind: 'org-models' };
  return { kind: 'organization' };
}
