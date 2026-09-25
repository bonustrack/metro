import { createContext, type ReactNode, useContext } from 'react';
import { Text } from './ui.js';
import { CountBadge } from './CountBadge.js';

const InCard = createContext(false);

export const useInCard = (): boolean => useContext(InCard);

export function SettingsGroup({ title, note, action, children }: { title?: string; note?: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="settings-group">
      {title === undefined ? null : (
        <div className="settings-group-head">
          <Text size="lg" weight="medium">
            {title}
          </Text>
          {action}
        </div>
      )}
      {note === undefined ? null : (
        <Text size="sm" role="secondary">
          {note}
        </Text>
      )}
      <div className="settings-card">
        <InCard.Provider value>{children}</InCard.Provider>
      </div>
    </section>
  );
}

export function EmptyCard({ text }: { text: string }): ReactNode {
  return (
    <SettingsGroup>
      <div className="settings-pad">
        <Text size="sm" role="secondary">
          {text}
        </Text>
      </div>
    </SettingsGroup>
  );
}

export function SettingsSection({ title, note, count, leading, compact = false, sub = false, children }: { title: string; note?: string; count?: number; leading?: ReactNode; compact?: boolean; sub?: boolean; children: ReactNode }): ReactNode {
  const shape = sub ? 'settings-row is-compact is-sub' : compact ? 'settings-row is-compact' : 'settings-row';
  return (
    <div className={shape}>
      {leading === undefined ? null : <div className="settings-row-lead">{leading}</div>}
      <div className="settings-row-text">
        <span className="settings-row-title">
          <Text size="md" weight="medium">
            {title}
          </Text>
          {count === undefined ? null : <CountBadge count={count} />}
        </span>
        {note === undefined ? null : (
          <Text size="sm" role="secondary">
            {note}
          </Text>
        )}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function FactRow({ label, value, href, danger = false }: { label: string; value: string; href?: string; danger?: boolean }): ReactNode {
  return (
    <SettingsSection title={label} compact>
      <Text size="sm" role={danger ? 'danger' : 'secondary'} numberOfLines={1}>
        {href === undefined ? (
          value
        ) : (
          <a className="hint-link" href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        )}
      </Text>
    </SettingsSection>
  );
}
