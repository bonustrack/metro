import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { PageTitle } from './PageTitle.js';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { AgentPicture } from './AgentOverview.js';
import { ServerSizeSection } from './ServerSize.js';
import { ServerStorageSection } from './ServerStorage.js';
import { ServerResources } from './ServerResources.js';
import { DeleteServerSection } from './DeleteServer.js';
import { useServersQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { serverLabel } from '../api/servers.js';
import { type Selection } from './selection.js';

const OFFLINE_PAGES: Selection['kind'][] = ['agent-settings', 'settings'];

export const worksOffline = (kind: Selection['kind']): boolean => OFFLINE_PAGES.includes(kind);

const WHY = 'Nothing on this page can be read while the box does not answer. Its name, picture and address are kept by Metro, so Settings still works.';

export function OfflinePanel({ onRetry }: { onRetry: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  const name = server === undefined ? 'This agent' : serverLabel(server);
  return (
    <Col gap={20}>
      <Row align="center" gap={16}>
        <AgentPicture server={server} seed={here?.host ?? name} />
        <Col gap={4} flex={1} minWidth={0}>
          <PageTitle>{name}</PageTitle>
          <Row gap={8} align="center" wrap>
            <Badge label="Offline" color="secondary" variant="soft" pill />
            {here === null ? null : (
              <Text size="2xs" role="secondary" numberOfLines={1}>
                {here.host}
              </Text>
            )}
          </Row>
        </Col>
      </Row>
      <Text size="2xs" role="secondary">
        {WHY}
      </Text>
      <Button size="md" color="secondary" dark={dark} label="Try again" onPress={onRetry} />
      {server === undefined ? null : <ServerResources serverId={server.id} />}
      {server === undefined ? null : <ServerSizeSection serverId={server.id} launchedOnly />}
      {server === undefined ? null : <ServerStorageSection serverId={server.id} launchedOnly />}
      {server === undefined ? null : <DeleteServerSection server={server} />}
    </Col>
  );
}
