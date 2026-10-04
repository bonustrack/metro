import { type ReactElement, type ReactNode } from 'react';
import { Path, Svg } from 'react-native-svg';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { RouteLink } from './RouteLink.js';

function BackIcon({ size, color }: { size: number; color: string }): ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M19 12H5m0 0l6-6m-6 6l6 6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const SELF = { alignSelf: 'flex-start', maxWidth: '100%' } as const;

export function BackLink({ label, href }: { label: string; href: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <RouteLink to={href} label={label} style={SELF}>
      <Row align="center" gap={4} minWidth={0}>
        <BackIcon size={16} color={palette.sub} />
        <Text size="xs" role="secondary" numberOfLines={1}>
          {label}
        </Text>
      </Row>
    </RouteLink>
  );
}
