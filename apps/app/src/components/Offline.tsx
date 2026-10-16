import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { ServerSizeSection } from './ServerSize.js';
import { ServerStorageSection } from './ServerStorage.js';
import { ServerResources } from './ServerResources.js';
import { DeleteServerSection } from './DeleteServer.js';
import { useServersQuery } from '../lib/queries.js';
import { useTechnicalDetails } from '../lib/technical.js';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { type Selection } from '@metro-labs/client/selection';

const OFFLINE_PAGES: Selection['kind'][] = ['agent-settings', 'settings'];

export const worksOffline = (kind: Selection['kind']): boolean => OFFLINE_PAGES.includes(kind);

const WHY = 'The box does not answer, so this page is empty. Settings still works: Metro keeps its name, picture and address.';

export function OfflinePanel({ onRetry }: { onRetry: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  const technical = useTechnicalDetails();
  return (
    <Col gap={20}>
      {technical && here !== null ? (
        <Text size="xs" role="secondary" numberOfLines={1}>
          {here.host}
        </Text>
      ) : null}
      <Text size="md" role="secondary">
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
