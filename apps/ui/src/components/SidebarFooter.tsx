import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Dropdown } from './Dropdown';
import { NavRow } from './NavRow';
import { type Selection } from './selection';

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
      <NavRow
        label="Documentation"
        icon="bookOpen"
        selected={selection.kind === 'docs'}
        target={{ kind: 'docs' }}
        onSelect={onSelect}
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
