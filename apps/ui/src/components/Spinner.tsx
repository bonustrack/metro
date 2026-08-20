import { useEffect, useId, useRef, type ReactElement } from 'react';
import { Animated, Easing } from 'react-native';
import { Circle, Defs, G, LinearGradient, Path, Rect, Stop, Svg } from 'react-native-svg';

const SPIN_DURATION_MS = 500;

export function Spinner({ size = 20, color }: { size?: number; color: string }): ReactElement {
  const spin = useRef(new Animated.Value(0)).current;
  const gradientId = `spinner-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: SPIN_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Defs>
          <LinearGradient id={gradientId} x1="28.154%" y1="63.74%" x2="74.629%" y2="17.783%">
            <Stop stopColor={color} offset="0%" />
            <Stop stopColor={color} stopOpacity="0" offset="100%" />
          </LinearGradient>
        </Defs>
        <G transform="translate(2)" fill="none" fillRule="evenodd">
          <Circle stroke={`url(#${gradientId})`} strokeWidth="4" cx="10" cy="12" r="10" />
          <Path d="M10 2C4.477 2 0 6.477 0 12" stroke={color} strokeWidth="4" />
          <Rect x="8" width="4" height="4" rx="8" />
        </G>
      </Svg>
    </Animated.View>
  );
}
