import { Platform, useWindowDimensions } from 'react-native';

const NARROW_MAX = 1011;

export function useIsNarrow(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS !== 'web' || width <= NARROW_MAX;
}

export function useIsTouch(): boolean {
  if (Platform.OS !== 'web') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}
