import { type ReactNode } from 'react';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { isOperator } from '@metro-labs/client/api/admin';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import { setTechnicalDetails, useTechnicalDetails } from '../../lib/technical.js';

export function YourAccount({ onLock }: { onLock: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const technical = useTechnicalDetails();
  const account = activeAccount();
  if (account === null) return null;
  return (
    <Group label="Your account">
      <Item
        title={account.user.name ?? account.user.email ?? 'Account'}
        subtitle={account.user.name === null ? undefined : (account.user.email ?? undefined)}
        leading={<AgentAvatar seed={account.user.id} src={account.user.picture} size={AVATAR_SIZE.row} />}
        href={routeHash({ kind: 'settings' })}
      />
      <Item
        title="Show technical details"
        subtitle="Hosts, versions and ids"
        trailing={<Switch checked={technical} dark={dark} name="Show technical details" onChange={setTechnicalDetails} />}
      />
      {isOperator(account) ? <Item title="Admin" subtitle="Every agent, user and organization" leading={<Icon name="shield" size={ICON_SIZE.lg} color={palette.text} />} href={routeHash({ kind: 'admin' })} /> : null}
      <Item title="Sign out" onPress={onLock} chevron={false} />
    </Group>
  );
}
