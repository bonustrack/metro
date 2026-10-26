import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { agentSeed, removeServer, serverLabel, type RemoteServer } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { routeHash } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { AgentAvatar } from '../AgentAvatar.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { type MenuItem } from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { KebabMenu } from '../KebabMenu.js';
import { RouteLink } from '../RouteLink.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { side } from '../ui/edges.js';
import { PageHeader } from '../ui/PageHeader.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import { useAgentRows } from '../../lib/agent-rows.js';
import { useIsNarrow } from '../../lib/media.js';
import { go } from '../../lib/nav.js';
import { refreshServers } from '../../lib/queries.js';
import { REMOTE_TABS, remoteTabOf } from '../../lib/remote-tabs.js';
import { SHRINK } from '../../lib/style.js';
import { optionTabs } from '../../lib/option-tabs.js';

function RemoteMenu({ server }: { server: RemoteServer }): ReactNode {
  const client = useQueryClient();
  const name = serverLabel(server);
  const deleting = useConfirm(
    async () => {
      await removeServer(server.id);
      await refreshServers(client);
    },
    'Could not delete the agent.',
    () => { go({ kind: 'servers' }); },
  );
  const admin = activeAccount()?.role === 'admin';
  const items: MenuItem[] = [
    { label: 'Edit profile', icon: 'user', onSelect: () => { go({ kind: 'agent-profile', project: server.id }); } },
    ...(admin ? [{ label: `Delete ${name}`, danger: true, onSelect: deleting.show }] : []),
  ];
  return (
    <>
      <KebabMenu items={items} label={`Actions for ${name}`} />
      <ConfirmDialog confirming={deleting} title={`Delete ${name}?`} lines={['Its access keys stop working at once and its connectors leave it. Its past connector calls stay in the activity.']} action="Delete agent" name={name} />
    </>
  );
}

function RemoteTabs({ selection, project }: { selection: Selection; project: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column border={{ bottom: side(palette.border) }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Agent pages">
        <Tabs
          variant="underline"
          {...optionTabs(REMOTE_TABS.map((tab) => ({ value: tab.id, label: tab.label })), remoteTabOf(selection), (id) => {
            const tab = REMOTE_TABS.find((t) => t.id === id);
            if (tab !== undefined) go(tab.target(project));
          })}
        />
      </ScrollView>
    </Column>
  );
}

function Compact({ server, avatar, line, tabs }: { server: RemoteServer; avatar: ReactNode; line: string; tabs: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column gap={20}>
      <Row align="center" gap={12}>
        <RouteLink to={routeHash({ kind: 'servers' })} label="All agents">
          <Icon name="chevronLeft" size={ICON_SIZE.lg} color={palette.link} />
        </RouteLink>
        {avatar}
        <Column weight={1} minWidth={0} gap={2}>
          <Text accessibilityRole="header" size="md" fontWeight="semibold" numberOfLines={1} style={SHRINK}>
            {serverLabel(server)}
          </Text>
          <Text size="xs" color="secondary" numberOfLines={1}>{line}</Text>
        </Column>
        <RemoteMenu server={server} />
      </Row>
      {tabs}
    </Column>
  );
}

export function RemoteHeader({ server, selection }: { server: RemoteServer; selection: Selection }): ReactNode {
  const narrow = useIsNarrow();
  const row = useAgentRows([server])[0];
  const line = row?.line.text ?? 'No server';
  const tabs = <RemoteTabs selection={selection} project={server.id} />;
  const avatar = (
    <AvatarDot mark="plug">
      <AgentAvatar seed={agentSeed(server)} src={server.avatar} size={narrow ? AVATAR_SIZE.list : AVATAR_SIZE.header} />
    </AvatarDot>
  );
  if (narrow) return <Compact server={server} avatar={avatar} line={line} tabs={tabs} />;
  return <PageHeader title={serverLabel(server)} subtitle={line} leading={avatar} action={<RemoteMenu server={server} />} tabs={tabs} />;
}
