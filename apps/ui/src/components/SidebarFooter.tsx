import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from './AgentAvatar';
import { Dropdown } from './Dropdown';
import { NAV_GAP, NAV_ICON_SIZE, NAV_ROW_BOX, NavRow } from './NavRow';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { type Selection } from './selection';
import { shortAddress } from '../api/address';

interface SidebarFooterProps {
  project: string;
  subject: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function SidebarFooter({ project, subject, selection, onSelect, onLock }: SidebarFooterProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Col gap={NAV_GAP} padding={{ x: 24, bottom: 24, top: 16 }}>
      <NavRow label="Documentation" icon="bookOpen" selected={selection.kind === 'docs'} target={{ kind: 'docs' }} onSelect={onSelect} />
      <Row {...NAV_ROW_BOX}>
        <Icon name="globeAlt" size={NAV_ICON_SIZE} color={palette.sub} />
        <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>
          {project}
        </Text>
      </Row>
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
          <AgentAvatar seed={subject} size={NAV_ICON_SIZE} />
          <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>
            {shortAddress(subject)}
          </Text>
        </Row>
      </Dropdown>
    </Col>
  );
}
