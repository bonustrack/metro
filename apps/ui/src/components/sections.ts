import { type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { type Selection } from './selection.js';

type Kind = Selection['kind'];

export interface SectionTab {
  label: string;
  kinds: Kind[];
  target: (project: string) => Selection;
  newTab?: boolean;
}

export interface Section {
  id: string;
  label: string;
  icon: HeroIconName;
  kinds: Kind[];
  target: (project: string) => Selection;
  tabs?: SectionTab[];
}

const MEMORY_TABS: SectionTab[] = [
  { label: 'Notes', kinds: ['memory'], target: (project) => ({ kind: 'memory', project, claudeProject: null, file: null }) },
  { label: 'Files', kinds: ['files'], target: (project) => ({ kind: 'files', project, path: '' }) },
  { label: 'Conversations', kinds: ['sessions'], target: (project) => ({ kind: 'sessions', project, claudeProject: null, id: null }) },
];

const SETTINGS_TABS: SectionTab[] = [
  { label: 'General', kinds: ['agent-settings'], target: (project) => ({ kind: 'agent-settings', project }) },
  { label: 'Harness', kinds: ['claude'], target: (project) => ({ kind: 'claude', project }) },
  { label: 'Scheduled tasks', kinds: ['scheduled', 'scheduled-job'], target: (project) => ({ kind: 'scheduled', project }) },
  { label: 'Secrets', kinds: ['secrets'], target: (project) => ({ kind: 'secrets', project }) },
  { label: 'Server', kinds: ['server'], target: (project) => ({ kind: 'server', project }) },
  { label: 'Terminal', kinds: ['terminal'], target: (project) => ({ kind: 'terminal', project }), newTab: true },
];

export const SECTIONS: Section[] = [
  { id: 'home', label: 'Home', icon: 'home', kinds: ['home', 'none'], target: (project) => ({ kind: 'home', project }) },
  { id: 'channels', label: 'Channels', icon: 'chat', kinds: ['stations', 'station'], target: (project) => ({ kind: 'stations', project }) },
  { id: 'connectors', label: 'Connectors', icon: 'viewGridAdd', kinds: ['connectors', 'connector'], target: (project) => ({ kind: 'connectors', project }) },
  { id: 'model', label: 'Model', icon: 'chip', kinds: ['model'], target: (project) => ({ kind: 'model', project }) },
  { id: 'skills', label: 'Skills', icon: 'sparkles', kinds: ['skills', 'skill'], target: (project) => ({ kind: 'skills', project }) },
  {
    id: 'memory',
    label: 'Memory',
    icon: 'bookmark',
    kinds: MEMORY_TABS.flatMap((tab) => tab.kinds),
    target: (project) => ({ kind: 'memory', project, claudeProject: null, file: null }),
    tabs: MEMORY_TABS,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'cog',
    kinds: SETTINGS_TABS.flatMap((tab) => tab.kinds),
    target: (project) => ({ kind: 'agent-settings', project }),
    tabs: SETTINGS_TABS,
  },
];

export function sectionOf(kind: Kind): Section | undefined {
  return SECTIONS.find((section) => section.kinds.includes(kind));
}
