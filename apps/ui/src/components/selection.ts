export type Selection =
  | { kind: 'none' }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'authorize' }
  | { kind: 'machine'; id: string }
  | { kind: 'agents'; project: string }
  | { kind: 'agent'; project: string; id: string }
  | { kind: 'station'; project: string; accountId: string }
  | { kind: 'connectors'; project: string }
  | { kind: 'connector'; project: string; id: string }
  | { kind: 'collections'; project: string }
  | { kind: 'collection'; project: string; id: string }
  | { kind: 'members'; project: string }
  | { kind: 'project'; project: string };

export function selectionProject(selection: Selection): string | null {
  return 'project' in selection ? selection.project : null;
}
