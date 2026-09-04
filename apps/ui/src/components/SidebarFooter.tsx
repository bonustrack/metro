import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from './AgentAvatar';
import { Dropdown, type MenuItem } from './Dropdown';
import { NameModal } from './NameModal';
import { NAV_GAP, NAV_ICON_SIZE, NAV_ROW_BOX, NavIcon, NavRow } from './NavRow';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { type Selection } from './selection';
import { shortAddress } from '../api/address';
import { baseFromSegment, daemonHost } from '../auth/daemon';
import { daemonLabel, daemonName, forgetDaemon, goToDaemon, knownDaemons, nameDaemon } from '../auth/daemons';

interface SidebarFooterProps {
  project: string;
  subject: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

function serverItems(current: string, onRename: () => void): MenuItem[] {
  const others = knownDaemons().filter((d) => d.base !== current);
  return [
    ...others.map((d) => ({
      label: d.name ?? daemonHost(d.base),
      onSelect: () => {
        goToDaemon(d.base);
      },
    })),
    { label: daemonName(current) === null ? 'Name this server' : 'Rename this server', icon: 'pencil' as const, onSelect: onRename },
    {
      label: 'Add a server',
      icon: 'plus' as const,
      onSelect: () => {
        window.location.hash = '#/connect';
      },
    },
    {
      label: 'Forget this server',
      danger: true,
      onSelect: () => {
        forgetDaemon(current);
        window.location.hash = '#/connect';
      },
    },
  ];
}

export function SidebarFooter({ project, subject, selection, onSelect, onLock }: SidebarFooterProps): ReactNode {
  const palette = useKitPalette();
  const current = baseFromSegment(project);
  const [renaming, setRenaming] = useState(false);
  const [, setVersion] = useState(0);
  return (
    <Col gap={NAV_GAP} padding={{ x: 24, bottom: 24, top: 16 }}>
      <NavRow label="Documentation" icon="bookOpen" selected={selection.kind === 'docs'} target={{ kind: 'docs' }} onSelect={onSelect} />
      <Dropdown
        className="account-trigger"
        label="Server menu"
        align="start"
        items={serverItems(current, () => {
          setRenaming(true);
        })}
      >
        <Row {...NAV_ROW_BOX}>
          <NavIcon name="globeAlt" color={palette.sub} />
          <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>
            {daemonLabel(current)}
          </Text>
        </Row>
      </Dropdown>
      <NameModal
        title="Name this server"
        action="Save"
        placeholder={daemonHost(current)}
        initial={daemonName(current) ?? ''}
        failure="Could not save the name."
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onSubmit={(name) => {
          nameDaemon(current, name);
          setVersion((v) => v + 1);
          return Promise.resolve(name);
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
