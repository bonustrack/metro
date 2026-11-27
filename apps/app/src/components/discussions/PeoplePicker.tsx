import { type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { queryError, useOrganizationQuery } from '../../lib/queries.js';
import { SHRINK } from '../../lib/style.js';

export const togglePicked = (picked: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(picked);
  if (!next.delete(id)) next.add(id);
  return next;
};

export function PeoplePicker({ owner, picked, toggle }: { owner: string; picked: ReadonlySet<string>; toggle: (id: string) => void }): ReactNode {
  const palette = useKitPalette();
  const { data, error, refetch } = useOrganizationQuery();
  if (error !== null) return <ErrorState title="Could not read the members" text={queryError(error, 'metro.box did not answer.')} onRetry={refetch} />;
  if (data === undefined) return <RowsSkeleton rows={3} />;
  const others = data.members.filter((m) => m.userId !== owner);
  if (others.length === 0) return <Text size="sm" color="secondary">Nobody else is in this organization yet.</Text>;
  return (
    <Column gap={2}>
      {others.map((member) => (
        <Pressable key={member.userId} accessibilityRole="checkbox" accessibilityState={{ checked: picked.has(member.userId) }} onPress={() => { toggle(member.userId); }}>
          <Row align="center" gap={12} padding={{ x: 12, y: 8 }} radius={10}>
            <AgentAvatar seed={member.userId} src={member.picture} size={24} />
            <Text size="md" numberOfLines={1} style={SHRINK}>{member.name ?? member.email ?? 'A member'}</Text>
            <Column weight={1} />
            <Icon name={picked.has(member.userId) ? 'checkCircle' : 'plus'} size={ICON_SIZE.md} color={picked.has(member.userId) ? palette.link : palette.sub} />
          </Row>
        </Pressable>
      ))}
    </Column>
  );
}
