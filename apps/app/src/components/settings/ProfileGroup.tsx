import { type ReactNode, useState } from 'react';
import { routeHash } from '@metro-labs/client/route';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { setClaudeLiveEvents } from '@metro-labs/client/api/claude-box';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { AgentAvatar } from '../AgentAvatar.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { queryError, refresh, useClaudeSetupQuery } from '../../lib/queries.js';
import { SHRINK } from '../../lib/style.js';
import { AVATAR_SIZE } from '../ui/sizes.js';

const PAUSE_NOTE = 'Tools keep working.';

export interface Pausing {
  shown: boolean;
  paused: boolean;
  busy: boolean;
  error: string | null;
  toggle: (paused: boolean) => void;
}

export function usePausing(): Pausing {
  const client = useQueryClient();
  const setup = useClaudeSetupQuery();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = setup.data?.liveEvents ?? null;
  const toggle = (paused: boolean): void => {
    setBusy(true);
    setError(null);
    setClaudeLiveEvents(!paused)
      .then(() => refresh(client, 'claude-setup'))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change whether messages arrive.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { shown: live !== null, paused: live === false, busy, error, toggle };
}

function PauseRow(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const pausing = usePausing();
  if (!pausing.shown) return null;
  const admin = activeAccount()?.role === 'admin';
  return (
    <Item
      title="Pause messages"
      subtitle={pausing.error ?? PAUSE_NOTE}
      subtitleTone={pausing.error === null ? 'secondary' : 'danger'}
      trailing={<Switch name="Pause messages" checked={pausing.paused} disabled={pausing.busy || !admin} dark={dark} onChange={pausing.toggle} />}
      chevron={false}
    />
  );
}

function NameValue({ server }: { server: Server }): ReactNode {
  return (
    <Row align="center" gap={10} style={SHRINK}>
      <AgentAvatar seed={server.host} src={server.avatar} size={AVATAR_SIZE.row} />
      <Text size="md" numberOfLines={1} style={SHRINK}>
        {serverLabel(server)}
      </Text>
    </Row>
  );
}

export function ProfileGroup({ server }: { server: Server }): ReactNode {
  return (
    <Group label="Profile">
      <Item title="Name, picture and web address" trailing={<NameValue server={server} />} chevron href={routeHash({ kind: 'agent-profile', project: server.id })} />
      <PauseRow />
    </Group>
  );
}
