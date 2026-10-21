import { type ReactNode } from 'react';
import type { AccountGroup } from '@metro-labs/client/api/accounts';
import { stationLabel } from '@metro-labs/client/api/attach';
import { channelTrouble, connectionWords } from '@metro-labs/client/api/pair-again';
import { routeHash } from '@metro-labs/client/route';
import { StationIcon } from '../StationIcon.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { useNow } from '../../lib/use-now.js';

const CLOCK_MS = 30_000;

export function ChannelAlerts({ project, groups }: { project: string; groups: AccountGroup[] }): ReactNode {
  const now = useNow(CLOCK_MS);
  const trouble = channelTrouble(groups);
  if (trouble.length === 0) return null;
  return (
    <Group label="Needs attention">
      {trouble.map(({ station, accountId, status }) => {
        const words = connectionWords(status, now);
        return (
          <Item
            key={`${station}/${accountId}`}
            leading={<StationIcon station={station} size={AVATAR_SIZE.row} />}
            title={`${stationLabel(station)} ${words.title.toLowerCase()}`}
            danger
            subtitle={words.note}
            href={routeHash({ kind: 'station', project, accountId })}
          />
        );
      })}
    </Group>
  );
}
