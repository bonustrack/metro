import type { PushState } from './push-state.js';

export function pushNote(state: PushState): string | undefined {
  if (state === 'blocked') return 'Notifications are blocked for Metro on this phone. Allow them in Android settings, then turn this on.';
  if (state === 'unavailable') return 'This version of the app cannot receive notifications yet. Update the app, then try again.';
  return undefined;
}
