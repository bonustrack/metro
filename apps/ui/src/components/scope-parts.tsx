import { type ReactNode } from 'react';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { AgentAvatar } from './AgentAvatar.js';
import { StatusDot } from './StatusDot.js';
import { opensElsewhere } from './link.js';

const CHECK = 16;
const ICON = 18;

export function statusWord(state: string | undefined): string {
  if (state === undefined) return 'Checking…';
  if (state === 'live') return 'Online';
  if (state === 'stopped') return 'Stopped';
  return 'Offline';
}

export function Face({ server, size }: { server: { host: string; avatar: string | null }; size: number }): ReactNode {
  return (
    <span className="agent-face">
      <AgentAvatar seed={server.host} src={server.avatar} size={size} />
      <span className="agent-face-dot">
        <StatusDot host={server.host} />
      </span>
    </span>
  );
}

interface ScopeItemProps {
  label: string;
  current?: boolean;
  shown?: boolean;
  onHover?: () => void;
  href?: string;
  leading?: ReactNode;
  icon?: HeroIconName;
  onSelect: () => void;
}

export function ScopeItem({ label, current = false, shown = false, onHover, href, leading, icon, onSelect }: ScopeItemProps): ReactNode {
  const palette = useKitPalette();
  const body = (
    <>
      {leading ?? null}
      {icon === undefined ? null : <Icon name={icon} size={ICON} color={palette.sub} />}
      <Text size="md" numberOfLines={1} style={SHRINK}>
        {label}
      </Text>
      <span className="scope-item-end">{current ? <Icon name="check" size={CHECK} color={palette.link} /> : null}</span>
    </>
  );
  const shape = shown ? 'scope-item is-shown' : 'scope-item';
  if (href !== undefined)
    return (
      <a
        className={shape}
        href={href}
        onMouseEnter={onHover}
        onFocus={onHover}
        onClick={(e) => {
          e.stopPropagation();
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onSelect();
        }}
      >
        {body}
      </a>
    );
  return (
    <button type="button" className={shape} onClick={onSelect} onMouseEnter={onHover} onFocus={onHover}>
      {body}
    </button>
  );
}

export function ScopeColumn({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="scope-column">
      <span className="scope-column-title">{title}</span>
      {children}
    </div>
  );
}
