import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { SaveField, useSave } from './SaveField.js';
import { AgentAvatar } from './AgentAvatar.js';
import { useImagePicker } from './AvatarPicker.js';
import { updateAccount } from '../api/auth.js';
import { activeAccount, type Account } from '../auth/account.js';

const PAGE_AVATAR = 56;
const NAME_MAX = 80;

function Picture({ account, onChanged }: { account: Account; onChanged: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const picker = useImagePicker(async (next) => {
    await updateAccount({ avatar: next });
    onChanged();
  });
  return (
    <Row align="center" gap={16} wrap>
      <AgentAvatar seed={account.user.id} src={account.user.picture} size={PAGE_AVATAR} />
      <Button size="md" color="secondary" dark={dark} label={picker.busy ? 'Saving…' : 'Set picture'} loading={picker.busy} disabled={picker.busy} onPress={picker.pick} />
      {account.user.picture === null ? null : <Button size="md" color="secondary" dark={dark} label="Remove picture" disabled={picker.busy} onPress={picker.remove} />}
      {picker.error === null ? null : (
        <Text size="md" role="danger">
          {picker.error}
        </Text>
      )}
      {picker.input}
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
    <Col gap={8}>
      <SaveField saving={saving} name="account-name" label="Name" placeholder={account.user.email ?? ''} />
    </Col>
  );
}

export function AccountSettings(): ReactNode {
  const [, bump] = useState(0);
  const account = activeAccount();
  if (account === null) return null;
  const changed = (): void => {
    bump((n) => n + 1);
  };
  return (
    <Col gap={12}>
      <Col gap={2}>
        <Text size="xl" weight="medium">Account</Text>
        <Text size="md" role="secondary">
          {account.user.email ?? ''}
        </Text>
      </Col>
      <Picture account={account} onChanged={changed} />
      <Name key={account.user.name ?? ''} account={account} onChanged={changed} />
    </Col>
  );
}
