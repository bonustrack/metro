export type Selection =
  | { kind: 'none' }
  | { kind: 'servers' }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'connect' }
  | { kind: 'launch' }
  | { kind: 'members' }
  | { kind: 'home'; project: string }
  | { kind: 'server'; project: string }
  | { kind: 'terminal'; project: string }
  | { kind: 'model'; project: string }
  | { kind: 'stations'; project: string }
  | { kind: 'station'; project: string; accountId: string }
  | { kind: 'connectors'; project: string }
  | { kind: 'connector'; project: string; id: string }
  | { kind: 'sessions'; project: string; claudeProject: string | null; id: string | null }
  | { kind: 'memory'; project: string; claudeProject: string | null; file: string | null }
  | { kind: 'claude'; project: string }
  | { kind: 'skills'; project: string }
  | { kind: 'skill'; project: string; id: string };

export function selectionProject(selection: Selection): string | null {
  return 'project' in selection ? selection.project : null;
}

type PlainKind = 'home' | 'server' | 'terminal' | 'model' | 'stations' | 'connectors' | 'claude' | 'skills';
type LandingKind = PlainKind | 'sessions' | 'memory';

const LANDS_ON: Partial<Record<Selection['kind'], LandingKind>> = {
  home: 'home',
  server: 'server',
  terminal: 'terminal',
  model: 'model',
  stations: 'stations',
  station: 'stations',
  connectors: 'connectors',
  connector: 'connectors',
  claude: 'claude',
  skills: 'skills',
  skill: 'skills',
  sessions: 'sessions',
  memory: 'memory',
};

export function sameViewOn(selection: Selection, project: string): Selection {
  const kind = LANDS_ON[selection.kind] ?? 'home';
  if (kind === 'sessions') return { kind, project, claudeProject: null, id: null };
  if (kind === 'memory') return { kind, project, claudeProject: null, file: null };
  return { kind, project };
}
