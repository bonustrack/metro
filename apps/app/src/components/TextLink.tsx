import { type ReactNode } from 'react';
import { Link } from 'expo-router';
import { Text } from '@stage-labs/kit/react-native/text';
import { type TextSizeToken } from '@stage-labs/kit/react-native/text';
import { type TextStyle } from 'react-native';
import { pathOfHash } from '../lib/location.js';
import { openExternal } from '../lib/open.js';

const UNDERLINE: TextStyle = { textDecorationLine: 'underline' };

interface TextLinkProps {
  children: ReactNode;
  size?: TextSizeToken;
  to?: string;
  url?: string;
  onPress?: () => void;
}

export function TextLink({ children, size = '2xs', to, url, onPress }: TextLinkProps): ReactNode {
  if (to !== undefined)
    return (
      <Link href={pathOfHash(to)} push>
        <Text size={size} role="link" style={UNDERLINE}>
          {children}
        </Text>
      </Link>
    );
  return (
    <Text
      size={size}
      role="link"
      style={UNDERLINE}
      accessibilityRole="link"
      onPress={() => {
        if (url !== undefined) openExternal(url);
        onPress?.();
      }}
    >
      {children}
    </Text>
  );
}
