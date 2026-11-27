import { AppState, Platform } from 'react-native';
import { focusManager } from '@tanstack/react-query';

export function followAppState(): void {
  if (Platform.OS === 'web') return;
  focusManager.setEventListener((focused) => {
    const watch = AppState.addEventListener('change', (state) => {
      focused(state === 'active');
    });
    return () => {
      watch.remove();
    };
  });
}
