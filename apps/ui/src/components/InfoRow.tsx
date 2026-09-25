import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';

interface InfoRowProps {
  label: string;
  value: string;
  href?: string;
  danger?: boolean;
  padY?: number;
}

export function InfoRow({ label, value, href, danger = false, padY = 10 }: InfoRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row justify="between" align="center" gap={16} padding={{ y: padY }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Text size="sm" role="secondary">
        {label}
      </Text>
      <Text size="sm" numberOfLines={1} style={SHRINK} role={danger ? 'danger' : undefined}>
        {href === undefined ? (
          value
        ) : (
          <a className="hint-link" href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        )}
      </Text>
    </Row>
  );
}
