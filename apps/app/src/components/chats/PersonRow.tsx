import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from '../AgentAvatar.js';
import { Dropdown, type MenuItem } from '../Dropdown.js';
import { side } from '../ui/edges.js';
import { type Person } from '../../lib/channel-people.js';
import { openExternal } from '../../lib/open.js';
import { AVATAR_SIZE } from '../ui/sizes.js';


const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 },
});

interface PersonRowProps {
  person: Person;
  busy: boolean;
  onApprove: (approves: boolean) => void;
  onRemove: () => void;
}

function menuOf(person: Person, busy: boolean, onRemove: () => void): MenuItem[] {
  const link = person.link;
  return [
    ...(link === null ? [] : [{ label: `Open a chat with ${person.title}`, icon: 'chat' as const, onSelect: () => { openExternal(link); } }]),
    { label: 'Remove', danger: true, onSelect: () => { if (!busy) onRemove(); } },
  ];
}

export function PersonRow({ person, busy, onApprove, onRemove }: PersonRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={14} minHeight={60} border={{ bottom: side(palette.border) }}>
      <Column weight={1} minWidth={0}>
        <Dropdown items={menuOf(person, busy, onRemove)} label={`Actions for ${person.title}`} align="start" style={styles.trigger}>
          <AgentAvatar seed={person.id} src={person.avatar} size={AVATAR_SIZE.row} />
          <Column weight={1} minWidth={0} gap={2}>
            <Text size="md" numberOfLines={1}>
              {person.title}
            </Text>
            {person.subtitle === null ? null : (
              <Text size="xs" color="secondary" numberOfLines={1}>
                {person.subtitle}
              </Text>
            )}
          </Column>
        </Dropdown>
      </Column>
      {person.approves === null ? null : <CheckBox displayStyle="switch" value={person.approves} disabled={busy} name={`${person.title} can approve`} onChange={onApprove} />}
    </Row>
  );
}
