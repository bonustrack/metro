import { Platform } from 'react-native';
import { location } from '@metro-labs/client/platform';

type Listener = () => void;

const listeners = new Set<Listener>();

export function onRelaunch(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function land(hash: string): void {
  if (Platform.OS === 'web') {
    window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
    window.location.reload();
    return;
  }
  location().replace(hash);
  for (const listener of listeners) listener();
}
