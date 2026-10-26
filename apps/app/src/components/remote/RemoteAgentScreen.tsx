import { type ReactNode, useEffect } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type RemoteServer } from '@metro-labs/client/api/servers';
import { storeServerId } from '@metro-labs/client/auth/daemon';
import type { Selection } from '@metro-labs/client/selection';
import { ActivityFeed } from '../activity/ActivityFeed.js';
import { AgentConnectorPage } from '../connectors/AgentConnectorPage.js';
import { GatewayUsage } from '../models/GatewayUsage.js';
import { ProfilePage } from '../settings/ProfilePage.js';
import { Tabbed } from '../tabbed.js';
import { Wide } from '../ui/Layout.js';
import { AccessKeys } from '../tools/AccessKeys.js';
import { RemoteApprovals } from './RemoteApprovals.js';
import { RemoteConnectors } from './RemoteConnectors.js';
import { RemoteHeader } from './RemoteHeader.js';
import { useIsNarrow } from '../../lib/media.js';
import { REMOTE_TABS, remoteTabOf } from '../../lib/remote-tabs.js';
import { webOnly } from '../../lib/style.js';
import { useDocumentTitle } from '../../lib/title.js';

const STICKY = webOnly({ position: 'sticky', top: 0, zIndex: 3 });

function TabBody({ server, selection }: { server: RemoteServer; selection: Selection }): ReactNode {
  const tab = remoteTabOf(selection);
  const name = serverLabel(server);
  useDocumentTitle(tab === 'connectors' ? name : `${REMOTE_TABS.find((one) => one.id === tab)?.label ?? ''} - ${name}`);
  if (tab === 'keys') return <AccessKeys agent={server.id} />;
  if (tab === 'activity')
    return (
      <Wide>
        <Column gap={40}>
          <GatewayUsage agent={server.id} label="Gateway" />
          <ActivityFeed key={server.id} agent={server.id} fixed />
        </Column>
      </Wide>
    );
  return <RemoteConnectors agent={server.id} name={name} />;
}

export function RemoteAgentScreen({ server, selection }: { server: RemoteServer; selection: Selection }): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  useEffect(() => {
    storeServerId(server.id);
  }, [server.id]);
  if (selection.kind === 'tools' && selection.connector !== undefined) return <AgentConnectorPage project={server.id} id={selection.connector} remote />;
  if (selection.kind === 'agent-profile') return <ProfilePage project={server.id} remote />;
  const top = narrow ? null : { backgroundColor: palette.bg };
  return (
    <Column gap={24}>
      <Column style={narrow ? undefined : [STICKY, top]}>
        <RemoteHeader server={server} selection={selection} />
      </Column>
      {remoteTabOf(selection) === 'connectors' ? <RemoteApprovals agent={server.id} /> : null}
      <Tabbed.Provider value>
        <TabBody server={server} selection={selection} />
      </Tabbed.Provider>
    </Column>
  );
}
