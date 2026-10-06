import { type ReactNode } from 'react';
import { type Selection } from '@metro-labs/client/selection';
import { AdminArea, isAdminSelection } from './AdminArea.js';
import { LaunchServer } from './LaunchServer.js';
import { Members } from './Members.js';
import { Organization } from './Organization.js';
import { Servers } from './Servers.js';
import { AllAgents } from './AllAgents.js';
import { ServerGate } from './gates.js';

export function UnlockedPage({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  if (selection.kind === 'all-agents') return <AllAgents onLock={onLock} />;
  if (isAdminSelection(selection)) return <AdminArea selection={selection} onLock={onLock} />;
  if (selection.kind === 'launch') return <LaunchServer />;
  if (selection.kind === 'members') return <Members onLock={onLock} />;
  if (selection.kind === 'organization') return <Organization onLock={onLock} />;
  if (selection.kind === 'servers' || selection.kind === 'none') return <Servers onLock={onLock} />;
  return <ServerGate selection={selection} onLock={onLock} />;
}
