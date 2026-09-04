import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { AgentAvatar } from './AgentAvatar';
import { Dropdown, type MenuItem } from './Dropdown';
import { NameModal } from './NameModal';
import { NAV_GAP, NAV_ICON_SIZE, NAV_ROW_BOX, NavIcon, NavRow } from './NavRow';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { type Selection } from './selection';
import { shortAddress } from '../api/address';
import { removeServer, renameServer, serverLabel, type Server } from '../api/servers';
import { refreshServers, useServersQuery } from '../api/queries';

interface SidebarFooterProps {
  project: string;
  subject: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

function serverItems(servers: Server[], current: Server | undefined, onRename: () => void, onForget: () => void): MenuItem[] {
  const others = servers.filter((s) => s.id !== current?.id);
  return [
    ...others.map((s) => ({
      label: serverLabel(s),
      onSelect: () => {
        window.location.hash = `#/${s.id}`;
      },
    })),
    {
      label: 'All servers',
      icon: 'viewList' as const,
      onSelect: () => {
        window.location.hash = '#/';
      },
    },
    ...(current === undefined
      ? []
      : [
          { label: current.name === null ? 'Name this server' : 'Rename this server', icon: 'pencil' as const, onSelect: onRename },
          { label: 'Remove this server', danger: true, onSelect: onForget },
        ]),
  ];
}

export function SidebarFooter({ project, subject, selection, onSelect, onLock }: SidebarFooterProps): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const { data } = useServersQuery();
  const servers = data ?? [];
  const current = servers.find((s) => s.id === project);
  const [renaming, setRenaming] = useState(false);
  const forget = (): void => {
    if (current === undefined) return;
    removeServer(current.id)
      .then(() => refreshServers(client))
      .then(() => {
        window.location.hash = '#/';
      })
      .catch(() => undefined);
  };
  return (
    <Col gap={NAV_GAP} padding={{ x: 24, bottom: 24, top: 16 }}>
      <NavRow label="Documentation" icon="bookOpen" selected={selection.kind === 'docs'} target={{ kind: 'docs' }} onSelect={onSelect} />
      <Dropdown
        className="account-trigger"
        label="Server menu"
        align="start"
        items={serverItems(servers, current, () => {
          setRenaming(true);
        }, forget)}
      >
        <Row {...NAV_ROW_BOX}>
          <NavIcon name="globeAlt" color={palette.sub} />
          <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>
            {current === undefined ? project : serverLabel(current)}
          </Text>
        </Row>
      </Dropdown>
      <NameModal
        title="Name this server"
        action="Save"
        placeholder={current?.host ?? ''}
        initial={current?.name ?? ''}
        failure="Could not save the name."
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onSubmit={async (name) => {
          if (current === undefined) return null;
          const saved = await renameServer(current.id, name);
          await refreshServers(client);
          return saved;
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
