import { useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import { modalKeyboardInset } from './modal-keyboard.js';

export function useKeyboardInset(): number {
  const { height } = useWindowDimensions();
  const [top, setTop] = useState<number | null>(() => Keyboard.metrics()?.screenY ?? null);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillChangeFrame', (event) => { setTop(event.endCoordinates.screenY); });
    const hide = Keyboard.addListener('keyboardDidHide', () => { setTop(null); });
    return () => { show.remove(); hide.remove(); };
  }, []);
  return modalKeyboardInset(Platform.OS, height, top);
}
