import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { selectionProject, type Selection } from '@metro-labs/client/selection';
import { AdminArea } from './AdminArea.js';
import { InviteButton } from './Members.js';
import { Organization, OrganizationGroups } from './Organization.js';
import { ConnectorsIdle, OrgConnectorList } from './OrgConnectors.js';
import { OrgConnectorPage } from './OrgConnectorPage.js';
import { AddConnectorPage } from './connectors/AddConnectorPage.js';
import { Settings } from './Settings.js';
import { ServerGate } from './gates.js';
import { AgentList } from './agents/AgentList.js';
import { AgentsIdle } from './agents/AgentsIdle.js';
import { Jump } from './jump/Jump.js';
import { LaunchFlow } from './launch/LaunchFlow.js';
import { DefaultRoute } from './models/DefaultRoute.js';
import { ModelAccount } from './models/ModelAccount.js';
import { ModelList, type ModelPick } from './models/ModelList.js';
import { YourAccount } from './shell/YourAccount.js';
import { Groups } from './ui/Group.js';
import { AppShell } from './shell/AppShell.js';
import { TabRoot } from './shell/TabRoot.js';
import { isAdminSelection, shellSectionOf } from '../lib/shell-sections.js';
import { useIsNarrow } from '../lib/media.js';

interface PageProps {
  selection: Selection;
  onLock: () => void;
  narrow: boolean;
}

function OrganizationRoot({ onLock }: { onLock: () => void }): ReactNode {
  const admin = activeAccount()?.role === 'admin';
  return (
    <TabRoot title="Organization" action={admin ? <InviteButton compact /> : undefined}>
      <Groups>
        <OrganizationGroups />
        <YourAccount onLock={onLock} />
      </Groups>
    </TabRoot>
  );
}

function modelsPage(selection: Selection, narrow: boolean): ReactNode {
  if (selection.kind === 'org-models') return narrow ? <ModelList pane={false} /> : <DefaultRoute />;
  if (selection.kind === 'org-route') return <DefaultRoute />;
  if (selection.kind === 'org-model') return <ModelAccount id={selection.id} />;
  return null;
}

function organizationPage({ selection, onLock, narrow }: PageProps): ReactNode {
  if (selection.kind === 'org-connectors') return narrow ? <OrgConnectorList pane={false} /> : <ConnectorsIdle />;
  if (selection.kind === 'org-connector') return <OrgConnectorPage id={selection.id} tab={selection.tab} agent={selection.agent} />;
  const models = modelsPage(selection, narrow);
  if (models !== null) return models;
  if (selection.kind === 'settings') return <Settings />;
  if (selection.kind !== 'organization' && selection.kind !== 'members') return null;
  return narrow ? <OrganizationRoot onLock={onLock} /> : <Organization />;
}

function SectionPage(props: PageProps): ReactNode {
  const { selection, onLock, narrow } = props;
  if (selectionProject(selection) !== null) return <ServerGate selection={selection} onLock={onLock} />;
  const page = organizationPage(props);
  if (page !== null) return page;
  return narrow ? <AgentList pane={false} /> : <AgentsIdle />;
}

function modelPick(selection: Selection): ModelPick {
  if (selection.kind === 'org-model') return { kind: 'account', id: selection.id };
  return selection.kind === 'org-models' || selection.kind === 'org-route' ? { kind: 'route' } : null;
}

function listOf(selection: Selection): ReactNode {
  const section = shellSectionOf(selection);
  if (section === 'agents') return <AgentList pane selected={selectionProject(selection)} />;
  if (section === 'connectors') return <OrgConnectorList pane selected={selection.kind === 'org-connector' ? selection.id : null} />;
  if (section === 'models') return <ModelList pane pick={modelPick(selection)} />;
  return null;
}

export function UnlockedPage({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  const narrow = useIsNarrow();
  if (isAdminSelection(selection)) return <AdminArea selection={selection} onLock={onLock} />;
  if (selection.kind === 'launch') return <LaunchFlow />;
  if (selection.kind === 'org-connector-new') return <AddConnectorPage />;
  if (selection.kind === 'terminal') return <ServerGate selection={selection} onLock={onLock} />;
  return (
    <>
      <AppShell selection={selection} onLock={onLock} list={narrow ? null : listOf(selection)}>
        <SectionPage selection={selection} onLock={onLock} narrow={narrow} />
      </AppShell>
      <Jump />
    </>
  );
}
