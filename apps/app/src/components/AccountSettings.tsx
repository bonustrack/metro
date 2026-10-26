import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { SaveField, useSave } from './SaveField.js';
import { AgentAvatar } from './AgentAvatar.js';
import { useImagePicker } from './AvatarPicker.js';
import { Block } from './settings/rows.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { AVATAR_SIZE } from './ui/sizes.js';
import { updateAccount } from '@metro-labs/client/api/auth';
import { activeAccount, type Account } from '@metro-labs/client/auth/account';

const NAME_MAX = 80;

function PictureButtons({ busy, shown, onPick, onRemove }: { busy: boolean; shown: boolean; onPick: () => void; onRemove: () => void }): ReactNode {
  return (
    <Row gap={8} align="center">
      {shown ? <Button size="sm" color="secondary" label="Remove" disabled={busy} onPress={onRemove} /> : null}
      <Button size="sm" color="secondary" label={busy ? 'Saving…' : 'Change'} loading={busy} disabled={busy} onPress={onPick} />
    </Row>
  );
}

function Name({ account, onChanged }: { account: Account; onChanged: () => void }): ReactNode {
  const saving = useSave({
    initial: account.user.name ?? '',
    clean: (name) => name.trim().replace(/\s+/g, ' '),
    valid: (name) => name !== '' && name.length <= NAME_MAX,
    run: async (name) => {
      await updateAccount({ name });
      onChanged();
    },
    failure: 'Could not save the name.',
  });
  return (
    <Block gap={10}>
      <Text size="md">Name</Text>
      <SaveField saving={saving} name="account-name" label="Name" placeholder={account.user.email ?? ''} />
    </Block>
  );
}

export function AccountSettings(): ReactNode {
  const [, bump] = useState(0);
  const account = activeAccount();
  const changed = (): void => {
    bump((n) => n + 1);
  };
  const picker = useImagePicker(async (next) => {
    await updateAccount({ avatar: next });
    changed();
  });
  if (account === null) return null;
  return (
    <Group label="Profile" error={picker.error}>
      <Item
        title="Picture"
        subtitle={account.user.picture === null ? 'A pattern made from your account' : 'Shown to the people in your organization'}
        leading={<AgentAvatar seed={account.user.id} src={account.user.picture} size={AVATAR_SIZE.list} />}
        trailing={<PictureButtons busy={picker.busy} shown={account.user.picture !== null} onPick={picker.pick} onRemove={picker.remove} />}
        chevron={false}
      />
      <Name key={account.user.name ?? ''} account={account} onChanged={changed} />
      <Item title="Email" value={account.user.email ?? ''} />
    </Group>
  );
}
