import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from './AgentAvatar.js';
import { Dropdown } from './Dropdown.js';
import { MetroLogo } from './MetroLogo.js';
import { StatusDot } from './StatusDot.js';
import { opensElsewhere } from './link.js';
import { serverLabel, type Server } from '../api/servers.js';
import { useServersQuery } from '../api/queries.js';
import { activeAccount } from '../auth/account.js';
import { currentServer } from '../auth/daemon.js';
import { routeHash } from '../route.js';
import { sameViewOn, type Selection } from './selection.js';

const AVATAR = 32;
const LOGO = 22;

function RailItem({ server, selected, selection }: { server: Server; selected: boolean; selection: Selection }): ReactNode {
  const label = serverLabel(server);
  const href = routeHash(sameViewOn(selection, server.id));
  return (
    <a
      className={selected ? 'rail-item rail-item-selected' : 'rail-item'}
      href={href}
      aria-label={label}
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
      <RailTip label={label} />
    </a>
  );
}

const TIP_TEXT = { fontSize: 17, lineHeight: '20px' } as const;

function RailTip({ label }: { label: string }): ReactNode {
  return (
    <span className="rail-tip" aria-hidden="true">
      <span className="rail-tip-label" style={TIP_TEXT}>
        {label}
      </span>
    </span>
  );
}

function RailAccount({ onLock }: { onLock: () => void }): ReactNode {
  const account = activeAccount();
  const label = account?.user.name ?? account?.user.email ?? 'Account';
  return (
    <Dropdown
      className="rail-account"
      label="Account menu"
      align="start"
      items={[
        {
          label: 'Settings',
          onSelect: () => {
            window.location.hash = routeHash({ kind: 'settings' });
          },
        },
        { label: 'Log out', danger: true, onSelect: onLock },
      ]}
    >
      <span className="rail-avatar">
        <AgentAvatar seed={account?.user.id ?? 'account'} src={account?.user.picture ?? null} size={AVATAR} />
      </span>
      <RailTip label={label} />
    </Dropdown>
  );
}

export function ServerRail({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  const palette = useKitPalette();
  const { data } = useServersQuery();
  const here = currentServer();
  return (
    <nav className="server-rail" aria-label="Agents">
      <a className="rail-logo" href={routeHash({ kind: 'servers' })} aria-label="All agents">
        <MetroLogo size={LOGO} color={palette.link} />
        <RailTip label="All agents" />
      </a>
      <div className="rail-list">
        {(data ?? []).map((server) => (
          <RailItem key={server.id} server={server} selected={server.id === here?.id} selection={selection} />
        ))}
      </div>
      <RailAccount onLock={onLock} />
    </nav>
  );
}
