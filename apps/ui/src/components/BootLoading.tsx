import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { MetroLogo } from './MetroLogo';

const LOGO_SIZE = 64;

export function BootLoading(): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="center" align="center" style={{ flex: 1, padding: 24 }}>
      <div className="boot-pulse" aria-label="Loading Metro">
        <MetroLogo size={LOGO_SIZE} color={dark ? '#ffffff' : '#000000'} />
      </div>
    </Row>
  );
}
