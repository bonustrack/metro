import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { AgentMenu } from './AgentMenu.js';
import { agentHealth, type AgentHealth } from '../../lib/agent-health.js';
import { useClaudeSessionQuery, useServerStatus } from '../../lib/queries.js';
import { useIsNarrow } from '../../lib/media.js';
import { SHRINK } from '../../lib/style.js';

const WIDE_AVATAR = 48;
const NARROW_AVATAR = 40;
const BACK = 26;
const SELF = { alignSelf: 'flex-start', maxWidth: '100%' } as const;

function Status({ health }: { health: AgentHealth }): ReactNode {
  const text = (
    <Text size="xs" role="secondary" numberOfLines={1}>
      {health.text}
    </Text>
  );
  if (health.fix === undefined) return text;
  return (
    <RouteLink to={routeHash(health.fix)} label={health.text} style={SELF}>
      {text}
    </RouteLink>
  );
}

export function AgentHeader({ server, project }: { server: Server; project: string }): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const status = useServerStatus(server.host);
  const session = useClaudeSessionQuery();
  const health = agentHealth(status.data?.state, session.data, project);
  const size = narrow ? NARROW_AVATAR : WIDE_AVATAR;
  return (
    <Row align="center" gap={narrow ? 12 : 14}>
      {narrow ? (
        <RouteLink to={routeHash({ kind: 'servers' })} label="All agents">
          <Icon name="chevronLeft" size={BACK} color={palette.link} />
        </RouteLink>
      ) : null}
      <AvatarDot dot={health.dot}>
        <AgentAvatar seed={server.host} src={server.avatar} size={size} />
      </AvatarDot>
      <Col flex={1} minWidth={0} gap={2}>
        <Text accessibilityRole="header" size={narrow ? 'md' : '2xl'} weight="semibold" numberOfLines={1} style={SHRINK}>
          {serverLabel(server)}
        </Text>
        <Status health={health} />
      </Col>
      <AgentMenu server={server} />
    </Row>
  );
}
