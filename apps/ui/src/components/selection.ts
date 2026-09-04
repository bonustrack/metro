export type Selection =
  | { kind: 'none' }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'connect'; url: string | null }
  | { kind: 'home'; project: string }
  | { kind: 'stations'; project: string }
  | { kind: 'station'; project: string; accountId: string }
  | { kind: 'connectors'; project: string }
  | { kind: 'connector'; project: string; id: string }
  | { kind: 'sessions'; project: string; claudeProject: string | null; id: string | null }
  | { kind: 'memory'; project: string; claudeProject: string | null; file: string | null };

export function selectionProject(selection: Selection): string | null {
  return 'project' in selection ? selection.project : null;
}
