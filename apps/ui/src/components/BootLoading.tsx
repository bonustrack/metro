import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { LOGO_ASPECT, MetroLogo } from './MetroLogo.js';
import { useLoadingVisible } from '../loading-delay.js';

const LOGO_WIDTH = 64;
const LOGO_SIZE = Math.round(LOGO_WIDTH / LOGO_ASPECT);

export function BootLoading(): ReactNode {
  const palette = useKitPalette();
  const visible = useLoadingVisible();
  if (!visible) return null;
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <div className="boot-pulse" aria-label="Loading Metro">
        <MetroLogo size={LOGO_SIZE} color={palette.link} />
      </div>
    </Row>
  );
}
