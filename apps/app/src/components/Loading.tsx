import { type ReactNode, useEffect, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/row';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Spinner } from './Spinner.js';

const DELAY_MS = 100;

export function useLoadingVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return visible;
}

export function Loading(): ReactNode {
  const palette = useKitPalette();
  const visible = useLoadingVisible();
  if (!visible) return null;
  return (
    <Row justify="center" align="center" weight={1} padding={24}>
      <Spinner color={palette.link} />
    </Row>
  );
}
