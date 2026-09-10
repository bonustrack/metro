import { type ReactNode, useState } from 'react';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { queryError } from '../api/queries.js';

interface ToggleAccountProps {
  station: string;
  accountId: string;
  enabled: boolean;
  onToggle: (station: string, accountId: string, enabled: boolean) => Promise<void>;
}

export function ToggleAccount({ station, accountId, enabled, onToggle }: ToggleAccountProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (): void => {
    setBusy(true);
    setError(null);
    onToggle(station, accountId, !enabled)
      .catch((err: unknown) => {
        setError(queryError(err, enabled ? 'Could not disable the channel.' : 'Could not enable the channel.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <>
      <Button size="md" color="secondary" dark={dark} label={enabled ? 'Disable' : 'Enable'} loading={busy} disabled={busy} onPress={flip} />
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </>
  );
}
