import { type ReactNode } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { activeAccount } from '../auth/account.js';
import { isOperator } from '../api/admin.js';
import { routeHash } from '../route.js';

const AVATAR = 28;
const MORE = 18;

export function AccountMenu({ onLock }: { onLock: () => void }): ReactNode {
  const palette = useKitPalette();
  const account = activeAccount();
  const name = account?.user.name ?? account?.user.email ?? 'Account';
  const items: MenuItem[] = [
    {
      label: 'Account settings',
      icon: 'user',
      onSelect: () => {
        window.location.hash = routeHash({ kind: 'settings' });
      },
    },
    ...(isOperator(account)
      ? [
          {
            label: 'Admin',
            icon: 'shieldCheck' as const,
            onSelect: () => {
              window.location.hash = routeHash({ kind: 'admin' });
            },
          },
        ]
      : []),
    { label: 'Log out', danger: true, onSelect: onLock },
  ];
  return (
    <Dropdown className="account-trigger" label="Account menu" align="start" items={items}>
      <AgentAvatar seed={account?.user.id ?? 'account'} src={account?.user.picture ?? null} size={AVATAR} />
      <Text size="md" numberOfLines={1} style={SHRINK}>
        {name}
      </Text>
      <Icon name="dotsHorizontal" size={MORE} color={palette.sub} />
    </Dropdown>
  );
}
