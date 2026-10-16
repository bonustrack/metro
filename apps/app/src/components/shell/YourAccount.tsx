import { type ReactNode } from 'react';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { isOperator } from '@metro-labs/client/api/admin';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { setTechnicalDetails, useTechnicalDetails } from '../../lib/technical.js';

const AVATAR = 40;

export function YourAccount({ onLock }: { onLock: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const technical = useTechnicalDetails();
  const account = activeAccount();
  if (account === null) return null;
  return (
    <Group label="Your account">
      <Item
        title={account.user.name ?? account.user.email ?? 'Account'}
        subtitle={account.user.name === null ? undefined : (account.user.email ?? undefined)}
        leading={<AgentAvatar seed={account.user.id} src={account.user.picture} size={AVATAR} />}
        href={routeHash({ kind: 'settings' })}
      />
      <Item
        title="Show technical details"
        subtitle="Hosts, versions and ids"
        trailing={<Switch checked={technical} dark={dark} name="Show technical details" onChange={setTechnicalDetails} />}
      />
      {isOperator(account) ? <Item title="Admin" href={routeHash({ kind: 'admin' })} /> : null}
      <Item title="Sign out" onPress={onLock} chevron={false} />
    </Group>
  );
}
