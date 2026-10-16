import { type ReactNode } from 'react';
import { selectionProject, type Selection } from '@metro-labs/client/selection';
import { AdminArea, isAdminSelection } from './AdminArea.js';
import { LaunchServer } from './LaunchServer.js';
import { Organization } from './Organization.js';
import { ConnectorsIdle, OrgConnectorList } from './OrgConnectors.js';
import { OrgConnectorPage } from './OrgConnectorPage.js';
import { OrgModels } from './OrgModels.js';
import { Settings } from './Settings.js';
import { ServerGate } from './gates.js';
import { AgentList } from './agents/AgentList.js';
import { AgentsIdle } from './agents/AgentsIdle.js';
import { YourAccount } from './shell/YourAccount.js';
import { Groups } from './ui/Group.js';
import { AppShell } from './shell/AppShell.js';
import { TabRoot } from './shell/TabRoot.js';
import { shellSectionOf } from '../lib/shell-sections.js';
import { useIsNarrow } from '../lib/media.js';

interface PageProps {
  selection: Selection;
  onLock: () => void;
  narrow: boolean;
}

function organizationPage({ selection, onLock, narrow }: PageProps): ReactNode {
  if (selection.kind === 'org-connectors') return narrow ? <OrgConnectorList pane={false} /> : <ConnectorsIdle />;
  if (selection.kind === 'org-connector') return <OrgConnectorPage id={selection.id} />;
  if (selection.kind === 'org-models') return narrow ? <TabRoot title="Models"><OrgModels /></TabRoot> : <OrgModels />;
  if (selection.kind === 'settings') return <Settings />;
  if (selection.kind !== 'organization' && selection.kind !== 'members') return null;
  if (!narrow) return <Organization />;
  return (
    <TabRoot title="Organization">
      <Groups>
        <Organization />
        <YourAccount onLock={onLock} />
      </Groups>
    </TabRoot>
  );
}

function SectionPage(props: PageProps): ReactNode {
  const { selection, onLock, narrow } = props;
  if (selectionProject(selection) !== null) return <ServerGate selection={selection} onLock={onLock} />;
  const page = organizationPage(props);
  if (page !== null) return page;
  return narrow ? <AgentList pane={false} /> : <AgentsIdle />;
}

function listOf(selection: Selection): ReactNode {
  const section = shellSectionOf(selection);
  if (section === 'agents') return <AgentList pane selected={selectionProject(selection)} />;
  if (section === 'connectors') return <OrgConnectorList pane selected={selection.kind === 'org-connector' ? selection.id : null} />;
  return null;
}

export function UnlockedPage({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  const narrow = useIsNarrow();
  if (isAdminSelection(selection)) return <AdminArea selection={selection} onLock={onLock} />;
  if (selection.kind === 'launch') return <LaunchServer />;
  if (selection.kind === 'terminal') return <ServerGate selection={selection} onLock={onLock} />;
  return (
    <AppShell selection={selection} onLock={onLock} list={narrow ? null : listOf(selection)}>
      <SectionPage selection={selection} onLock={onLock} narrow={narrow} />
    </AppShell>
  );
}
