import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { Pill } from './Pill.js';
import { AgentPicture } from './AgentOverview.js';
import { useServersQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { serverLabel } from '../api/servers.js';
import { type Selection } from './selection.js';

const OFFLINE_PAGES: Selection['kind'][] = ['agent-settings', 'settings', 'docs'];

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
            <Pill label="Offline" />
            {here === null ? null : (
              <Text size="sm" role="secondary" numberOfLines={1}>
                {here.host}
              </Text>
            )}
          </Row>
        </Col>
      </Row>
      <Text size="sm" role="secondary">
        {WHY}
      </Text>
      <Button size="sm" color="secondary" dark={dark} label="Try again" onPress={onRetry} />
    </Col>
  );
}
