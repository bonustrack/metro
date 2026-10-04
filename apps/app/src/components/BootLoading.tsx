import { type ReactNode, useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { LOGO_ASPECT, MetroLogo } from './MetroLogo.js';
import { useLoadingVisible } from './Loading.js';

const LOGO_WIDTH = 64;
const LOGO_SIZE = Math.round(LOGO_WIDTH / LOGO_ASPECT);
const HALF_MS = 700;

function usePulse(): Animated.Value {
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const step = (toValue: number): Animated.CompositeAnimation =>
      Animated.timing(value, { toValue, duration: HALF_MS, easing: Easing.inOut(Easing.ease), useNativeDriver: false });
    const loop = Animated.loop(Animated.sequence([step(0.35), step(1)]));
    loop.start();
    return () => {
      loop.stop();
    };
  }, [value]);
  return value;
}

export function BootLoading(): ReactNode {
  const palette = useKitPalette();
  const visible = useLoadingVisible();
  const opacity = usePulse();
  const pulse = { opacity };
  if (!visible) return null;
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Animated.View accessibilityLabel="Loading Metro" style={pulse}>
        <MetroLogo size={LOGO_SIZE} color={palette.link} />
      </Animated.View>
    </Row>
  );
}
