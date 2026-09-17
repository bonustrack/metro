import { type ReactNode } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from './AgentAvatar.js';
import { MetroLogo } from './MetroLogo.js';
import { StatusDot } from './StatusDot.js';
import { opensElsewhere } from './link.js';
import { serverLabel, type Server } from '../api/servers.js';
import { useServersQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { routeHash } from '../route.js';
import { sameViewOn, type Selection } from './selection.js';

const AVATAR = 32;
const LOGO = 22;
const PLUS = 18;

function RailItem({ server, selected, selection }: { server: Server; selected: boolean; selection: Selection }): ReactNode {
  const label = serverLabel(server);
  const href = routeHash(sameViewOn(selection, server.id));
  return (
    <a
      className={selected ? 'rail-item rail-item-selected' : 'rail-item'}
      href={href}
      aria-label={label}
      data-label={label}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        window.location.hash = href;
      }}
    >
      <span className="rail-avatar">
        <AgentAvatar seed={server.host} src={server.avatar} size={AVATAR} />
      </span>
      <span className="rail-status">
        <StatusDot host={server.host} />
      </span>
    </a>
  );
}

export function ServerRail({ selection }: { selection: Selection }): ReactNode {
  const palette = useKitPalette();
  const { data } = useServersQuery();
  const here = currentServer();
  return (
    <nav className="server-rail" aria-label="Servers">
      <a className="rail-logo" href="#/" aria-label="All servers" data-label="All servers">
        <MetroLogo size={LOGO} color={palette.link} />
      </a>
      <div className="rail-list">
        {(data ?? []).map((server) => (
          <RailItem key={server.id} server={server} selected={server.id === here?.id} selection={selection} />
        ))}
      </div>
      <a className="rail-item rail-add" href="#/connect" aria-label="Add a server" data-label="Add a server">
        <Icon name="plus" size={PLUS} color={palette.sub} />
      </a>
    </nav>
  );
}
