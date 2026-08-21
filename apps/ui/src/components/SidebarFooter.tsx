import { type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';
import { Dropdown } from './Dropdown';
import { type Selection } from './selection';

interface SidebarLinkProps {
  label: string;
  active?: boolean;
  onPress: () => void;
}

function SidebarLink({ label, active = false, onPress }: SidebarLinkProps): ReactNode {
  return (
    <Pressable accessibilityRole="link" onPress={onPress}>
      <Text size="lg" role={active ? 'link' : 'secondary'} weight={active ? 'semibold' : 'normal'}>
        {label}
      </Text>
    </Pressable>
  );
}

interface SidebarFooterProps {
  email: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function SidebarFooter({
  email,
  selection,
  onSelect,
  onLock,
}: SidebarFooterProps): ReactNode {
  return (
    <Col gap={10} padding={{ x: 24, bottom: 24, top: 16 }}>
      <SidebarLink
        label="Documentation"
        active={selection.kind === 'docs'}
        onPress={() => {
          onSelect({ kind: 'docs' });
        }}
      />
      <Dropdown
        className="account-trigger"
        label="Account menu"
        align="start"
        items={[
          {
            label: 'Settings',
            onSelect: () => {
              onSelect({ kind: 'settings' });
            },
          },
          { label: 'Log out', danger: true, onSelect: onLock },
        ]}
      >
        {email}
      </Dropdown>
    </Col>
  );
}
