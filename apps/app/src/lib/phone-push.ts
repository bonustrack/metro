import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import { readItem, writeItem } from '@metro-labs/client/platform';
import { activeAccount } from '@metro-labs/client/auth/account';
import { approvalLinkHash, registerPushDevice, unregisterPushDevice } from '@metro-labs/client/api/push-devices';
import { filled, recordOf } from '@metro-labs/client/read';
import { forgetPushDevice, pushTokenMoved, readPushState, startPush, turnPushOff, turnPushOn, type PermissionAnswer, type PushContext, type PushNative, type PushState } from './push-state.js';
import { goHash } from './nav.js';
import { logError } from './log.js';

type Notifications = typeof import('expo-notifications');
type TapResponse = Awaited<ReturnType<Notifications['getLastNotificationResponseAsync']>>;

export interface PushSwitch {
  state: PushState | null;
  busy: boolean;
  error: string | null;
  set: (on: boolean) => void;
  openSettings: () => void;
}

const CHANNEL = 'approvals';
const ASK_AFTER_MS = 4000;
const NATIVE_MODULES = ['ExpoPushTokenManager', 'ExpoNotificationPermissionsModule', 'ExpoNotificationsEmitter', 'ExpoNotificationChannelManager'];

let loading: Promise<Notifications | null> | null = null;
let shown: PushState | null = null;
let startedFor: string | null = null;
const listeners = new Set<() => void>();

function show(next: PushState): void {
  shown = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setUp(module: Notifications): Notifications {
  module.setNotificationHandler({ handleNotification: () => Promise.resolve({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
  return module;
}

function notifications(): Promise<Notifications | null> {
  if (Platform.OS !== 'android' || NATIVE_MODULES.some((name) => requireOptionalNativeModule(name) === null)) return Promise.resolve(null);
  loading ??= import('expo-notifications').then(setUp, (err: unknown) => {
    logError('push.load')(err);
    return null;
  });
  return loading;
}

const answerOf = (answer: { status: string; canAskAgain: boolean }): PermissionAnswer => ({
  status: answer.status === 'granted' || answer.status === 'denied' ? answer.status : 'undetermined',
  canAskAgain: answer.canAskAgain,
});

function nativeOf(module: Notifications): PushNative {
  const channel = async (): Promise<void> => {
    await module.setNotificationChannelAsync(CHANNEL, { name: 'Approvals', importance: module.AndroidImportance.HIGH });
  };
  return {
    permission: async () => answerOf(await module.getPermissionsAsync()),
    request: async () => {
      await channel();
      return answerOf(await module.requestPermissionsAsync());
    },
    prepare: channel,
    token: async () => {
      const projectId = filled(recordOf(Constants.expoConfig?.extra?.eas).projectId);
      return (await module.getExpoPushTokenAsync(projectId === null ? {} : { projectId })).data;
    },
  };
}

async function contextOf(): Promise<PushContext> {
  const module = await notifications();
  return {
    native: module === null ? null : nativeOf(module),
    server: { register: (token) => registerPushDevice(token, 'android'), unregister: unregisterPushDevice },
    store: { read: readItem, write: writeItem },
  };
}

function openFrom(response: TapResponse): void {
  const hash = approvalLinkHash(recordOf(response?.notification.request.content.data).url);
  if (hash !== null) goHash(hash);
}

function useNotificationTaps(): void {
  useEffect(() => {
    let alive = true;
    let remove = (): void => undefined;
    notifications()
      .then(async (module) => {
        if (module === null || !alive) return;
        const subscription = module.addNotificationResponseReceivedListener(openFrom);
        remove = () => {
          subscription.remove();
        };
        const last = await module.getLastNotificationResponseAsync();
        if (last === null || !alive) return;
        await module.clearLastNotificationResponseAsync();
        openFrom(last);
      })
      .catch(logError('push.taps'));
    return () => {
      alive = false;
      remove();
    };
  }, []);
}

function useTokenChanges(): void {
  useEffect(() => {
    let alive = true;
    let remove = (): void => undefined;
    notifications()
      .then((module) => {
        if (module === null || !alive) return;
        const subscription = module.addPushTokenListener(() => {
          contextOf().then(pushTokenMoved).then(show).catch(logError('push.token'));
        });
        remove = () => {
          subscription.remove();
        };
      })
      .catch(logError('push.listen'));
    return () => {
      alive = false;
      remove();
    };
  }, []);
}

export function usePhoneNotifications(): void {
  useNotificationTaps();
  useTokenChanges();
  const user = activeAccount()?.user.id ?? null;
  useEffect(() => {
    if (user === null || startedFor === user) return undefined;
    const timer = setTimeout(() => {
      startedFor = user;
      contextOf().then(startPush).then(show).catch(logError('push.start'));
    }, ASK_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [user]);
}

export function usePushSwitch(): PushSwitch {
  const state = useSyncExternalStore(subscribe, () => shown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    contextOf().then(readPushState).then(show).catch(logError('push.read'));
  }, []);
  const set = useCallback((on: boolean) => {
    setBusy(true);
    setError(null);
    contextOf()
      .then((ctx) => (on ? turnPushOn(ctx) : turnPushOff(ctx)))
      .then(show)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not change notifications.');
      })
      .finally(() => {
        setBusy(false);
      });
  }, []);
  const openSettings = useCallback(() => {
    Linking.openSettings().catch(logError('push.settings'));
  }, []);
  return { state, busy, error, set, openSettings };
}

export async function forgetPhonePush(): Promise<void> {
  startedFor = null;
  await forgetPushDevice(await contextOf());
}
