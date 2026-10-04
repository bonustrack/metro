import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { activeAccount } from '@metro-labs/client/auth/account';
import { isOperator } from '@metro-labs/client/api/admin';
import { Icon } from './Icon.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { go } from '../lib/nav.js';
import { SHRINK } from '../lib/style.js';

const AVATAR = 28;
const MORE = 18;
const TRIGGER = { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 6, marginHorizontal: -8, borderRadius: 8 } as const;

export function AccountMenu({ onLock, onNavigate }: { onLock: () => void; onNavigate: () => void }): ReactNode {
  const palette = useKitPalette();
  const account = activeAccount();
  const name = account?.user.name ?? account?.user.email ?? 'Account';
  const hover = { backgroundColor: palette.inputBg };
  const open = (kind: 'settings' | 'admin') => (): void => {
    onNavigate();
    go({ kind });
  };
  const items: MenuItem[] = [
    { label: 'Account settings', icon: 'user', onSelect: open('settings') },
    ...(isOperator(account) ? [{ label: 'Admin', icon: 'shieldCheck' as const, onSelect: open('admin') }] : []),
    { label: 'Log out', danger: true, onSelect: onLock },
  ];
  return (
    <Dropdown label="Account menu" align="start" items={items} style={TRIGGER} hoverStyle={hover}>
      <AgentAvatar seed={account?.user.id ?? 'account'} src={account?.user.picture ?? null} size={AVATAR} />
      <Row flex={1} minWidth={0}>
        <Text size="md" numberOfLines={1} style={SHRINK}>
          {name}
        </Text>
      </Row>
      <Icon name="dotsHorizontal" size={MORE} color={palette.sub} />
    </Dropdown>
  );
}

