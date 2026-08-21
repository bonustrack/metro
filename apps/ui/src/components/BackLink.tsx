import { type ReactElement, type ReactNode } from 'react';
import { Path, Svg } from 'react-native-svg';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';

function BackIcon({ size, color }: { size: number; color: string }): ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M19 12H5m0 0l6-6m-6 6l6 6"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

interface BackLinkProps {
  label: string;
  href: string;
  onPress: () => void;
}

export function BackLink({ label, href, onPress }: BackLinkProps): ReactNode {
  const palette = useKitPalette();
  return (
    <a
      className="back-link"
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onPress();
      }}
    >
      <BackIcon size={16} color={palette.sub} />
      <Text size="md" role="secondary" numberOfLines={1}>
        {label}
      </Text>
    </a>
  );
}
