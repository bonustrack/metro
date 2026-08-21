import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { MetroLogo } from './MetroLogo';

const LOGO_SIZE = 64;

export function BootLoading(): ReactNode {
  const palette = useKitPalette();
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <div className="boot-pulse" aria-label="Loading Metro">
        <MetroLogo size={LOGO_SIZE} color={palette.link} />
      </div>
    </Row>
  );
}
