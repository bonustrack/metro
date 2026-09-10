import { useQuery } from '@tanstack/react-query';
import { instanceState } from './launch.js';
import { bootingLaunch, readAwsSettings } from './settings.js';

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
