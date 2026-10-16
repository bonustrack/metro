import { type ReactNode } from 'react';
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
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
  onHoverIn?: (event: { currentTarget: unknown }) => void;
  onHoverOut?: () => void;
  children: ReactNode;
}

type LinkPressProps = PressableProps & { onClick?: PressableProps['onPress'] };

function LinkPress({ onClick, onPress, ...props }: LinkPressProps): ReactNode {
  return <Pressable {...props} onPress={onClick ?? onPress} />;
}

export function RouteLink({ to, label, style, hoverStyle, disabled = false, replace = false, onPress, onHoverIn, onHoverOut, children }: RouteLinkProps): ReactNode {
  const [hovered, hover] = useHover();
  const enter = (event: { currentTarget: unknown }): void => {
    hover.onHoverIn();
    onHoverIn?.(event);
  };
  const leave = (): void => {
    hover.onHoverOut();
    onHoverOut?.();
  };
  const frame = StyleSheet.flatten([style, hovered && !disabled ? hoverStyle : null]);
  if (disabled)
    return (
      <Pressable accessibilityLabel={label} disabled onHoverIn={enter} onHoverOut={leave} style={frame}>
        {children}
      </Pressable>
    );
  return (
    <Link href={pathOfHash(to)} asChild push={!replace} replace={replace} onPress={onPress}>
      <LinkPress accessibilityLabel={label} onHoverIn={enter} onHoverOut={leave} style={frame}>
        {children}
      </LinkPress>
    </Link>
  );
}
