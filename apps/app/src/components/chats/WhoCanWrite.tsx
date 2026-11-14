import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { PersonRow } from './PersonRow.js';
import { type Person } from '../../lib/channel-people.js';

interface WhoCanWriteProps {
  editing: boolean;
  note: string | undefined;
  error: string | null;
  people: Person[];
  busy: boolean;
  peopleNote?: string;
  approving?: boolean;
  onRestrict: () => void;
  onAnyone: () => void;
  onApprove?: (id: string, approves: boolean) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

function Check({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  return on ? <Icon name="check" size={ICON_SIZE.md} color={palette.link} /> : null;
}

export function WhoCanWrite({ editing, note, error, people, busy, peopleNote, approving = false, onRestrict, onAnyone, onApprove, onRemove, onAdd }: WhoCanWriteProps): ReactNode {
  const palette = useKitPalette();
  return (
    <>
      <Group label="Who can write" note={note} error={editing ? null : error}>
        <Item title="Only these people" trailing={<Check on={editing} />} chevron={false} onPress={onRestrict} />
        <Item title="Anyone" trailing={<Check on={!editing} />} chevron={false} onPress={onAnyone} />
      </Group>
      {editing ? (
        <Group label="People" action={approving ? <Text size="xs" color="secondary">Can approve</Text> : undefined} note={peopleNote} error={error}>
          {people.map((person) => (
            <PersonRow key={person.id} person={person} busy={busy} onApprove={(yes) => { onApprove?.(person.id, yes); }} onRemove={() => { onRemove(person.id); }} />
          ))}
          <Item title="Add a person" leading={<Icon name="plus" size={ICON_SIZE.md} color={palette.link} />} chevron={false} onPress={onAdd} />
        </Group>
      ) : null}
    </>
  );
}
