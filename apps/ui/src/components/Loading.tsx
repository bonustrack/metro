import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Spinner } from './Spinner';
import { useLoadingVisible } from '../loading-delay';

export function Loading(): ReactNode {
  const palette = useKitPalette();
  const visible = useLoadingVisible();
  if (!visible) return null;
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Spinner size={24} color={palette.link} />
    </Row>
  );
}
