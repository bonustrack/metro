import { type ReactNode } from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Link } from 'expo-router';
import { pathOfHash } from '../lib/location.js';
import { useHover } from './ui/hover.js';

interface RouteLinkProps {
  to: string;
  label?: string;
  style?: StyleProp<ViewStyle>;
  hoverStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  replace?: boolean;
  onPress?: (event: { preventDefault: () => void }) => void;
  onHoverIn?: () => void;
  children: ReactNode;
}

export function RouteLink({ to, label, style, hoverStyle, disabled = false, replace = false, onPress, onHoverIn, children }: RouteLinkProps): ReactNode {
  const [hovered, hover] = useHover();
  const enter = (): void => {
    hover.onHoverIn();
    onHoverIn?.();
  };
  const body = (
    <Pressable accessibilityLabel={label} disabled={disabled} onHoverIn={enter} onHoverOut={hover.onHoverOut} style={StyleSheet.flatten([style, hovered && !disabled ? hoverStyle : null])}>
      {children}
    </Pressable>
  );
  if (disabled) return body;
  return (
    <Link href={pathOfHash(to)} asChild push={!replace} replace={replace} onPress={onPress}>
      {body}
    </Link>
  );
}
