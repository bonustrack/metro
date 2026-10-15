import { type ReactNode } from 'react';
import { type Selection } from '@metro-labs/client/selection';
import { AdminArea, isAdminSelection } from './AdminArea.js';
import { LaunchServer } from './LaunchServer.js';
import { Organization } from './Organization.js';
import { OrgConnectors } from './OrgConnectors.js';
import { OrgConnectorPage } from './OrgConnectorPage.js';
import { OrgModels } from './OrgModels.js';
import { Servers } from './Servers.js';
import { ServerGate } from './gates.js';

export function UnlockedPage({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  if (isAdminSelection(selection)) return <AdminArea selection={selection} onLock={onLock} />;
  if (selection.kind === 'launch') return <LaunchServer />;
  if (selection.kind === 'organization' || selection.kind === 'members') return <Organization onLock={onLock} />;
  if (selection.kind === 'org-connectors') return <OrgConnectors onLock={onLock} />;
  if (selection.kind === 'org-connector') return <OrgConnectorPage id={selection.id} onLock={onLock} />;
  if (selection.kind === 'org-models') return <OrgModels onLock={onLock} />;
  if (selection.kind === 'servers' || selection.kind === 'none') return <Servers onLock={onLock} />;
  return <ServerGate selection={selection} onLock={onLock} />;
}
