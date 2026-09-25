import { useQuery } from '@tanstack/react-query';
import { queryError } from '../api/queries.js';
import { fetchBootView, fetchInstanceView, type BootView } from '../api/launch.js';
import type { Server } from '../api/servers.js';

const POLL_MS = 20_000;
const CONSOLE_POLL_MS = 30_000;
const BOOT_WINDOW_MS = 30 * 60_000;

function stillBooting(server: Server, now = Date.now()): boolean {
  if (server.instanceId === null || server.launchedAt === null) return false;
  const at = Date.parse(server.launchedAt);
  return Number.isFinite(at) && now - at < BOOT_WINDOW_MS;
}

export function useBootingState(server: Server, enabled: boolean): string | null {
  const booting = enabled && stillBooting(server);
  const { data } = useQuery({
    queryKey: ['launch-instance', server.id],
    enabled: booting,
    refetchInterval: POLL_MS,
    retry: false,
    queryFn: () => fetchInstanceView(server.id),
  });
  if (!booting) return null;
  return data?.state ?? 'starting';
}

const errorOf = (err: unknown): string | null =>
  err === null || err === undefined ? null : queryError(err, 'Could not read the instance.');

export interface LaunchWatch {
  instance: string | null;
  boot: BootView | null;
  error: string | null;
}

export function useLaunchWatch(serverId: string, done: boolean): LaunchWatch {
  const instance = useQuery({
    queryKey: ['launch-instance', serverId],
    enabled: !done,
    refetchInterval: POLL_MS,
    retry: false,
    queryFn: () => fetchInstanceView(serverId),
  });
  const boot = useQuery({
    queryKey: ['launch-boot', serverId],
    enabled: !done,
    refetchInterval: CONSOLE_POLL_MS,
    retry: false,
    queryFn: () => fetchBootView(serverId),
  });
  return {
    instance: instance.data?.state ?? null,
    boot: boot.data ?? null,
    error: errorOf(boot.error ?? instance.error),
  };
}
