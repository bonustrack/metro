import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import type { Selection } from '@metro-labs/client/selection';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { PageHeader } from '../ui/PageHeader.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { AgentMenu } from './AgentMenu.js';
import { healthFix } from '../../lib/agent-health.js';
import { useAgentRows } from '../../lib/agent-rows.js';
import { useClaudeSessionQuery, useServerStatus } from '../../lib/queries.js';
import { useIsNarrow } from '../../lib/media.js';
import { SHRINK } from '../../lib/style.js';

const BACK = 26;
const SELF = { alignSelf: 'flex-start', maxWidth: '100%' } as const;

function Status({ text, fix }: { text: string; fix: Selection | undefined }): ReactNode {
  const line = (
    <Text size="xs" role="secondary" numberOfLines={1}>
      {text}
    </Text>
  );
  if (fix === undefined) return line;
  return (
    <RouteLink to={routeHash(fix)} label={text} style={SELF}>
      {line}
    </RouteLink>
  );
}

function CompactHeader({ server, avatar, status, tabs }: { server: Server; avatar: ReactNode; status: ReactNode; tabs: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col gap={20}>
      <Row align="center" gap={12}>
        <RouteLink to={routeHash({ kind: 'servers' })} label="All agents">
          <Icon name="chevronLeft" size={BACK} color={palette.link} />
        </RouteLink>
        {avatar}
        <Col flex={1} minWidth={0} gap={2}>
          <Text accessibilityRole="header" size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
            {serverLabel(server)}
          </Text>
          {status}
        </Col>
        <AgentMenu server={server} />
      </Row>
      {tabs}
    </Col>
  );
}

export function AgentHeader({ server, project, tabs }: { server: Server; project: string; tabs: ReactNode }): ReactNode {
  const narrow = useIsNarrow();
  const status = useServerStatus(server.host);
  const session = useClaudeSessionQuery();
  const row = useAgentRows([server])[0];
  const avatar = (
    <AvatarDot dot={row?.line.dot ?? null}>
      <AgentAvatar seed={server.host} src={server.avatar} size={narrow ? AVATAR_SIZE.list : AVATAR_SIZE.header} />
    </AvatarDot>
  );
  const line = <Status text={row?.line.text ?? 'Checking…'} fix={healthFix(status.data?.state, session.data, project)} />;
  if (narrow) return <CompactHeader server={server} avatar={avatar} status={line} tabs={tabs} />;
  return <PageHeader title={serverLabel(server)} subtitle={line} leading={avatar} action={<AgentMenu server={server} />} tabs={tabs} />;
}
