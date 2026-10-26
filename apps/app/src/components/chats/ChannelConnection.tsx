import { type ReactNode } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import type { FlatAccount } from '@metro-labs/client/api/accounts';
import type { StationsView } from '@metro-labs/client/api/client';
import { connectionWords } from '@metro-labs/client/api/pair-again';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { useNow } from '../../lib/use-now.js';

const CLOCK_MS = 30_000;

export function ChannelConnection({ found, view, onPairAgain }: { found: FlatAccount; view: StationsView; onPairAgain: () => void }): ReactNode {
  const now = useNow(CLOCK_MS);
  const { station, row } = found;
  if (!view.reportsStatus.includes(station)) return null;
  const words = connectionWords(row.status, now);
  const canPair = view.pairAgain.includes(station) && row.status?.state === 'logged_out';
  return (
    <Group label="Connection">
      <Item
        title={words.title}
        danger={words.tone === 'danger'}
        subtitle={words.note}
        trailing={canPair ? <Button size="sm" color="primary" label="Pair again" onPress={onPairAgain} /> : undefined}
      />
    </Group>
  );
}
