import { type ReactNode } from 'react';
import { DeleteMenu } from './DeleteMenu.js';

interface DetachAccountProps {
  station: string;
  accountId: string;
  onDetach: (station: string, accountId: string) => Promise<void>;
}

const RECONNECT_NOTES: Record<string, string> = {
  webhook:
    'This cannot be undone. Connecting it again mints a new URL and a new secret, so whoever posts to this one has to be updated.',
  threema:
    'This cannot be undone. Connecting it again mints a new callback URL, which has to be pasted into the Gateway ID settings again.',
};

export function detachLines(station: string): string[] {
  const reconnectNote =
    RECONNECT_NOTES[station] ??
    'This cannot be undone. Connecting it again means going through the whole sign-in once more.';
  return ['This deletes the channel and the credentials Metro keeps for it. Messages stop reaching the agent at once.', reconnectNote];
}

export function DetachAccount({ station, accountId, onDetach }: DetachAccountProps): ReactNode {
  return (
    <DeleteMenu
      label="Channel actions"
      action="Delete channel"
      title="Delete channel"
      lines={detachLines(station)}
      word={accountId}
      failure="Could not delete the channel."
      run={() => onDetach(station, accountId)}
    />
  );
}
