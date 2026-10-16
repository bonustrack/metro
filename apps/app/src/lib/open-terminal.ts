import { Platform } from 'react-native';
import { routeHash } from '@metro-labs/client/route';
import { openExternal } from './open.js';
import { go } from './nav.js';

export function openTerminal(project: string): void {
  const target = { kind: 'terminal', project } as const;
  if (Platform.OS === 'web') openExternal(`${window.location.pathname}${routeHash(target)}`);
  else go(target);
}
