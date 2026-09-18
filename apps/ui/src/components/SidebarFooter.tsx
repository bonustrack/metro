import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { AgentAvatar } from './AgentAvatar.js';
import { Dropdown } from './Dropdown.js';
import { NAV_GAP, NAV_ICON_SIZE, NAV_ROW_BOX, NavRow } from './NavRow.js';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { type Selection } from './selection.js';
import { shortAddress } from '../api/address.js';
import { activeAccount } from '../auth/account.js';

interface SidebarFooterProps {
  subject: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function SidebarFooter({ subject, selection, onSelect, onLock }: SidebarFooterProps): ReactNode {
  const account = activeAccount();
  const label = account?.user.name ?? account?.user.email ?? shortAddress(subject);
  return (
    <Col gap={NAV_GAP} padding={{ x: 24, bottom: 24, top: 16 }}>
      <NavRow label="Documentation" icon="bookOpen" selected={selection.kind === 'docs'} target={{ kind: 'docs' }} onSelect={onSelect} />
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
        <Row {...NAV_ROW_BOX}>
          <AgentAvatar seed={account?.user.id ?? subject} src={account?.user.picture ?? null} size={NAV_ICON_SIZE} />
          <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>
            {label}
          </Text>
        </Row>
      </Dropdown>
    </Col>
  );
}
