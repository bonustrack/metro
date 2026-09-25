import type { ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { SettingsSection } from './SettingsSection.js';
import { windowLine, type UsageWindow } from '../api/usage.js';

const HIGH = 0.8;

function Meter({ used, warn }: { used: number; warn: boolean }): ReactNode {
  const fill = { width: `${String(Math.min(100, Math.round(used * 100)))}%` };
  return (
    <span className={warn ? 'meter is-warn' : 'meter'}>
      <span style={fill} />
    </span>
  );
}

export function UsageRow({ window }: { window: UsageWindow }): ReactNode {
  const warn = window.used !== null && window.used >= HIGH;
  const note = windowLine({ ...window, used: null });
  return (
    <SettingsSection title={window.label} note={note === '' ? undefined : note} compact>
      {window.used === null ? null : (
        <Row gap={10} align="center">
          <Meter used={window.used} warn={warn} />
          <Text size="sm" role={warn ? 'danger' : 'secondary'}>
            {`${String(Math.round(window.used * 100))}%`}
          </Text>
        </Row>
      )}
    </SettingsSection>
  );
}
