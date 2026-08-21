import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Spinner } from './Spinner';

export function Loading(): ReactNode {
  const palette = useKitPalette();
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Spinner size={24} color={palette.link} />
    </Row>
  );
}
