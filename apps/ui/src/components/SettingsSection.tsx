import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';

export function SettingsSection({ title, note, children }: { title: string; note?: string; children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col gap={12} padding={{ bottom: 20 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Col gap={2}>
        <Text weight="semibold">{title}</Text>
        {note === undefined ? null : (
          <Text size="sm" role="secondary">
            {note}
          </Text>
        )}
      </Col>
      {children}
    </Col>
  );
}
