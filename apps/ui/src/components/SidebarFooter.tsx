import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { AgentAvatar } from './AgentAvatar';
import { Dropdown } from './Dropdown';
import { NAV_GAP, NAV_ICON_SIZE, NAV_ROW_BOX, NavRow } from './NavRow';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { ProjectSwitcher } from './ProjectSwitcher';
import { type Selection } from './selection';

interface SidebarFooterProps {
  token: string;
  project: string;
  email: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function SidebarFooter({
  token,
  project,
  email,
  selection,
  onSelect,
  onLock,
}: SidebarFooterProps): ReactNode {
  return (
    <Col gap={NAV_GAP} padding={{ x: 24, bottom: 24, top: 16 }}>
      <NavRow
        label="Documentation"
        icon="bookOpen"
        selected={selection.kind === 'docs'}
        target={{ kind: 'docs' }}
        onSelect={onSelect}
      />
      <ProjectSwitcher token={token} project={project} onSelect={onSelect} />
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
          <AgentAvatar seed={email} size={NAV_ICON_SIZE} />
          <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>
            {email}
          </Text>
        </Row>
      </Dropdown>
    </Col>
  );
}
