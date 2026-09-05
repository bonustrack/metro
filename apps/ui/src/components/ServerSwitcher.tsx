import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useQueryClient } from '@tanstack/react-query';
import { Dropdown, type MenuItem } from './Dropdown';
import { NameModal } from './NameModal';
import { NavIcon } from './NavRow';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { removeServer, renameServer, serverLabel, type Server } from '../api/servers';
import { refreshServers, useServersQuery } from '../api/queries';

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

export function ServerSwitcher({ project }: { project: string }): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const { data } = useServersQuery();
  const servers = data ?? [];
  const current = servers.find((s) => s.id === project);
  const [renaming, setRenaming] = useState(false);
  const side = { width: 1, color: palette.border };
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
    <>
      <Dropdown
        className="account-trigger"
        label="Server menu"
        align="start"
        items={serverItems(servers, current, () => {
          setRenaming(true);
        }, forget)}
      >
        <Row
          align="center"
          gap={10}
          padding={{ x: 14, y: 10 }}
          radius={BLOCK_RADIUS_DEFAULT}
          border={{ top: side, right: side, bottom: side, left: side }}
        >
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
    </>
  );
}
