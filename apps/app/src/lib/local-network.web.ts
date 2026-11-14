import { useEffect, useState } from 'react';
import { firstPermission } from './local-network-state.js';
import { logError } from './log.js';

const listeners = new Set<(blocked: boolean) => void>();
let blocked = false;

function watch(status: PermissionStatus | null): void {
  if (status === null) return;
  const update = (): void => {
    blocked = status.state === 'denied';
    for (const listener of listeners) listener(blocked);
  };
  status.addEventListener('change', update);
  update();
}

const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
firstPermission(permissions).then(watch).catch(logError('local-network'));

export function useLocalNetworkBlocked(): boolean {
  const [now, setNow] = useState(blocked);
  useEffect(() => {
    listeners.add(setNow);
    setNow(blocked);
    return () => {
      listeners.delete(setNow);
    };
  }, []);
  return now;
}
