import { type ReactNode } from 'react';
import { ActivityIndicator } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';

export function Loading(): ReactNode {
  const palette = useKitPalette();
  return (
    <Row justify="center" align="center" style={{ minHeight: '100%', padding: 24 }}>
      <ActivityIndicator size="large" color={palette.primary} />
    </Row>
  );
}
