import type { PushState } from './push-state.js';

export interface PushSwitch {
  state: PushState | null;
  busy: boolean;
  error: string | null;
  set: (on: boolean) => void;
  openSettings: () => void;
}

const nothing = (): void => undefined;

const UNSUPPORTED: PushSwitch = { state: 'unsupported', busy: false, error: null, set: nothing, openSettings: nothing };

export function usePhoneNotifications(): void {
  return undefined;
}

export const usePushSwitch = (): PushSwitch => UNSUPPORTED;

export const forgetPhonePush = (): Promise<void> => Promise.resolve();
