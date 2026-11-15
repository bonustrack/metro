import { type ReactNode } from 'react';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { usePushSwitch } from '../lib/phone-push.js';
import { pushNote } from '../lib/push-words.js';

const LABEL = 'Notifications';
const TITLE = 'Notify me about approvals';

export function PhoneNotifications(): ReactNode {
  const push = usePushSwitch();
  if (push.state === 'unsupported') return null;
  if (push.state === null)
    return (
      <Group label={LABEL}>
        <RowsSkeleton rows={1} leading={false} />
      </Group>
    );
  return (
    <Group label={LABEL} note={pushNote(push.state)} error={push.error}>
      <Item
        title={TITLE}
        subtitle="When an agent waits for your answer"
        trailing={<CheckBox displayStyle="switch" name={TITLE} value={push.state === 'on'} disabled={push.busy} onChange={push.set} />}
      />
      {push.state === 'blocked' ? <Item title="Open Android settings" onPress={push.openSettings} /> : null}
    </Group>
  );
}
