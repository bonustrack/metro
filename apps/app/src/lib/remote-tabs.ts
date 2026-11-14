import type { Selection } from '@metro-labs/client/selection';

export type RemoteTabId = 'connectors' | 'keys' | 'gateway' | 'activity';

interface RemoteTab {
  id: RemoteTabId;
  label: string;
  target: (project: string) => Selection;
}

export const REMOTE_TABS: readonly RemoteTab[] = [
  { id: 'connectors', label: 'Connectors', target: (project) => ({ kind: 'home', project }) },
  { id: 'keys', label: 'Access keys', target: (project) => ({ kind: 'access-keys', project }) },
  { id: 'gateway', label: 'Gateway', target: (project) => ({ kind: 'model', project }) },
  { id: 'activity', label: 'Activity', target: (project) => ({ kind: 'agent-activity', project }) },
];

export function remoteTabOf(selection: Selection): RemoteTabId {
  if (selection.kind === 'access-keys') return 'keys';
  if (selection.kind === 'model') return 'gateway';
  return selection.kind === 'agent-activity' ? 'activity' : 'connectors';
}
