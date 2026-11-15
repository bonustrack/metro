import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { AgentAvatar } from '../AgentAvatar.js';
import { PageScroll } from '../PageScroll.js';
import { Readable } from '../ui/Layout.js';
import { RoundButton } from '../ui/RoundButton.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { useIsNarrow } from '../../lib/media.js';
import { go } from '../../lib/nav.js';
import { useServersQuery } from '../../lib/queries.js';

const TOP_WIDE = 64;
const TOP_NARROW = 16;
const BOTTOM = 64;

export function useApprovalAgent(): { name: string; server: Server | undefined } {
  const servers = useServersQuery().data;
  const server = servers?.find((one) => one.id === currentServer()?.id);
  return { name: server === undefined ? 'The agent' : serverLabel(server), server };
}

function AgentLine({ project }: { project: string }): ReactNode {
  const { name, server } = useApprovalAgent();
  return (
    <Row align="center" gap={14}>
      <AgentAvatar seed={server?.id ?? name} src={server?.avatar ?? null} size={AVATAR_SIZE.focus} />
      <Column weight={1} minWidth={0} gap={2}>
        <Text size="md" fontWeight="semibold" numberOfLines={1}>
          {name}
        </Text>
        <Text size="xs" color="secondary" numberOfLines={1}>
          Approval request
        </Text>
      </Column>
      <RoundButton label={`Close, back to ${name}`} icon="close" onPress={() => { go({ kind: 'home', project }); }} />
    </Row>
  );
}

export function ApprovalFrame({ project, children }: { project: string; children: ReactNode }): ReactNode {
  const narrow = useIsNarrow();
  const insets = useSafeAreaInsets();
  return (
    <PageScroll>
      <Column align="center" padding={{ x: narrow ? 20 : 24, top: insets.top + (narrow ? TOP_NARROW : TOP_WIDE), bottom: insets.bottom + BOTTOM }}>
        <Readable gap={narrow ? 28 : 36}>
          <AgentLine project={project} />
          {children}
        </Readable>
      </Column>
    </PageScroll>
  );
}
