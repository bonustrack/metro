export type ConnectorTab = 'agents' | 'settings';

export type Selection =
  | { kind: 'none' }
  | { kind: 'servers' }
  | { kind: 'settings' }
  | { kind: 'terms-of-use' }
  | { kind: 'privacy-policy' }
  | { kind: 'admin' }
  | { kind: 'admin-users' }
  | { kind: 'admin-organizations' }
  | { kind: 'admin-agents' }
  | { kind: 'launch' }
  | { kind: 'members' }
  | { kind: 'organization' }
  | { kind: 'org-connectors' }
  | { kind: 'org-connector'; id: string; tab?: ConnectorTab; agent?: string }
  | { kind: 'org-connector-new' }
  | { kind: 'org-models' }
  | { kind: 'org-route' }
  | { kind: 'org-model'; id: string }
  | { kind: 'home'; project: string }
  | { kind: 'run'; project: string }
  | { kind: 'agent-settings'; project: string }
  | { kind: 'server'; project: string }
  | { kind: 'terminal'; project: string }
  | { kind: 'model'; project: string }
  | { kind: 'chats'; project: string }
  | { kind: 'station'; project: string; accountId: string; rule?: string }
  | { kind: 'tools'; project: string; connector?: string }
  | { kind: 'sessions'; project: string; claudeProject: string | null; id: string | null }
  | { kind: 'memory'; project: string; claudeProject: string | null; file: string | null }
  | { kind: 'claude'; project: string }
  | { kind: 'skills'; project: string }
  | { kind: 'scheduled'; project: string }
  | { kind: 'scheduled-job'; project: string; id: string }
  | { kind: 'files'; project: string; path: string }
  | { kind: 'secrets'; project: string }
  | { kind: 'voice'; project: string }
  | { kind: 'skill'; project: string; id: string };

export function selectionProject(selection: Selection): string | null {
  return 'project' in selection ? selection.project : null;
}

type PlainKind = 'home' | 'run' | 'agent-settings' | 'server' | 'terminal' | 'model' | 'chats' | 'tools' | 'claude' | 'skills' | 'scheduled' | 'secrets' | 'voice';
type LandingKind = PlainKind | 'sessions' | 'memory' | 'files';

const LANDS_ON: Partial<Record<Selection['kind'], LandingKind>> = {
  home: 'home',
  run: 'run',
  'agent-settings': 'agent-settings',
  server: 'server',
  terminal: 'terminal',
  model: 'model',
  chats: 'chats',
  station: 'chats',
  tools: 'tools',
  claude: 'claude',
  skills: 'skills',
  scheduled: 'scheduled',
  'scheduled-job': 'scheduled',
  skill: 'skills',
  sessions: 'sessions',
  memory: 'memory',
  files: 'files',
  secrets: 'secrets',
  voice: 'voice',
};

export function sameViewOn(selection: Selection, project: string): Selection {
  const kind = LANDS_ON[selection.kind] ?? 'home';
  if (kind === 'sessions') return { kind, project, claudeProject: null, id: null };
  if (kind === 'memory') return { kind, project, claudeProject: null, file: null };
  if (kind === 'files') return { kind, project, path: '' };
  return { kind, project };
}
