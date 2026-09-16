import type { ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { StatusDot } from './StatusDot.js';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { serverLabel, type Server } from '../api/servers.js';
import { useServersQuery } from '../api/queries.js';
import { routeHash } from '../route.js';
import { sameViewOn, type Selection } from './selection.js';

function serverItems(servers: Server[], current: Server | undefined, selection: Selection): MenuItem[] {
  return [
    ...servers.map((s) => ({
      label: serverLabel(s),
      leading: <StatusDot host={s.host} />,
      ...(s.id === current?.id ? { icon: 'check' as const } : {}),
      onSelect: () => {
        window.location.hash = routeHash(sameViewOn(selection, s.id));
      },
    })),
    {
      label: 'All servers',
      icon: 'viewList' as const,
      onSelect: () => {
        window.location.hash = '#/';
      },
    },
  ];
}

export function ServerSwitcher({ project, selection }: { project: string; selection: Selection }): ReactNode {
  const palette = useKitPalette();
  const { data } = useServersQuery();
  const servers = data ?? [];
  const current = servers.find((s) => s.id === project);
  const side = { width: 1, color: palette.border };
  return (
    <Dropdown className="account-trigger" label="Server menu" align="start" items={serverItems(servers, current, selection)}>
      <Row
        align="center"
        gap={10}
        padding={{ x: 14, y: 10 }}
        radius={BLOCK_RADIUS_DEFAULT}
        border={{ top: side, right: side, bottom: side, left: side }}
      >
        <Text size="md" numberOfLines={1} style={SHRINK}>
          {current === undefined ? project : serverLabel(current)}
        </Text>
      </Row>
    </Dropdown>
  );
}
