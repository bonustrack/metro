import type { ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { SettingsSection } from './SettingsSection.js';
import { useModeQuery } from '../api/queries.js';
import { USAGE_SINCE, windowLine, type UsageWindow } from '../api/usage.js';
import { olderThan } from '../api/version.js';

const HIGH = 0.8;

function Meter({ used, warn }: { used: number; warn: boolean }): ReactNode {
  const fill = { width: `${String(Math.min(100, Math.round(used * 100)))}%` };
  return (
    <span className={warn ? 'meter is-warn' : 'meter'}>
      <span style={fill} />
    </span>
  );
}

function UsageBar({ used }: { used: number | null }): ReactNode {
  if (used === null) return null;
  const warn = used >= HIGH;
  return (
    <Row gap={10} align="center">
      <Meter used={used} warn={warn} />
      <Text size="md" role={warn ? 'danger' : 'secondary'}>
        {`${String(Math.round(used * 100))}%`}
      </Text>
    </Row>
  );
}

export function UsageRow({ window }: { window: UsageWindow }): ReactNode {
  const note = windowLine({ ...window, used: null });
  return (
    <SettingsSection title={window.label} note={note === '' ? undefined : note} compact>
      <UsageBar used={window.used} />
    </SettingsSection>
  );
}

export function UsageLine({ window }: { window: UsageWindow }): ReactNode {
  const note = windowLine({ ...window, used: null });
  return (
    <span className="usage-line">
      <Text size="md" role="secondary">
        {window.label}
      </Text>
      <UsageBar used={window.used} />
      {note === '' ? null : (
        <Text size="md" role="secondary">
          {note}
        </Text>
      )}
    </span>
  );
}

export function UsageUpdateHint({ pad = false }: { pad?: boolean }): ReactNode {
  const mode = useModeQuery();
  if (!olderThan(mode.data?.version ?? null, USAGE_SINCE)) return null;
  const hint = (
    <Text size="md" role="secondary">
      Update Metro to see the usage.
    </Text>
  );
  return pad ? <div className="settings-pad">{hint}</div> : hint;
}
