import { useQuery } from '@tanstack/react-query';
import { queryError } from '../api/queries.js';
import { metroSetupLines, type BootLog } from './boot-log.js';
import { bootLog, instanceState } from './launch.js';
import { bootingLaunch, readAwsSettings, type Launch } from './settings.js';

const POLL_MS = 20_000;

export function useBootingState(host: string, enabled: boolean): string | null {
  const launch = enabled ? bootingLaunch(host) : null;
  const settings = launch === null ? null : readAwsSettings();
  const { data } = useQuery({
    queryKey: ['aws-instance', host, launch?.instanceId ?? ''],
    enabled: launch !== null && settings !== null,
    refetchInterval: POLL_MS,
    retry: false,
    queryFn: () => (launch === null || settings === null ? Promise.resolve(null) : instanceState(settings, launch)),
  });
  if (launch === null) return null;
  return data === null || data === undefined ? 'starting' : data.state;
}

const CONSOLE_POLL_MS = 30_000;

const errorOf = (err: unknown): string | null => (err === null || err === undefined ? null : queryError(err, 'Could not read the instance.'));

export interface LaunchWatch {
  instance: string | null;
  log: BootLog | null;
  capturedAt: string | null;
  error: string | null;
}

export function useLaunchWatch(launch: Launch, done: boolean): LaunchWatch {
  const settings = readAwsSettings();
  const enabled = settings !== null && !done;
  const instance = useQuery({
    queryKey: ['aws-instance', launch.instanceId],
    enabled,
    refetchInterval: POLL_MS,
    retry: false,
    queryFn: () => (settings === null ? Promise.resolve(null) : instanceState(settings, launch)),
  });
  const console = useQuery({
    queryKey: ['aws-console', launch.instanceId],
    enabled,
    refetchInterval: CONSOLE_POLL_MS,
    retry: false,
    queryFn: () => (settings === null ? Promise.resolve(null) : bootLog(settings, launch)),
  });
  const output = console.data ?? null;
  return {
    instance: instance.data?.state ?? null,
    log: output === null ? null : metroSetupLines(output.text),
    capturedAt: output?.at ?? null,
    error: settings === null ? 'No AWS key is kept in this browser.' : errorOf(console.error ?? instance.error),
  };
}
