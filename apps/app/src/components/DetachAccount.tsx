import { type ReactNode } from 'react';
import { DeleteMenu } from './DeleteMenu.js';

interface DetachAccountProps {
  station: string;
  accountId: string;
  managed?: boolean;
  onDetach: (station: string, accountId: string) => Promise<void>;
}

const RECONNECT_NOTES: Record<string, string> = {
  webhook:
    'This cannot be undone. Connecting it again mints a new URL and a new secret, so whoever posts to this one has to be updated.',
  threema:
    'This cannot be undone. Connecting it again mints a new callback URL, which has to be pasted into the Gateway ID settings again.',
};

export function detachLines(station: string, managed = false): string[] {
  if (station === 'gmail' && managed) return [
    'This revokes Google access and deletes the Gmail channel and its local credentials. Messages stop reaching the agent.',
    'Google revokes all permissions and tokens for this Google account across every client in Metro’s Google app project. This also disconnects the same Google account on other Metro boxes using that project. You will need to sign in again there.',
    'If Google cannot revoke access, the connection is kept so you can retry.',
  ];
  const reconnectNote =
    RECONNECT_NOTES[station] ??
    'This cannot be undone. Connecting it again means going through the whole sign-in once more.';
  return ['This deletes the channel and the credentials Metro keeps for it. Messages stop reaching the agent at once.', reconnectNote];
}

export function DetachAccount({ station, accountId, managed = false, onDetach }: DetachAccountProps): ReactNode {
  return (
    <DeleteMenu
      label="Channel actions"
      action="Delete channel"
      title="Delete channel"
      lines={detachLines(station, managed)}
      word={accountId}
      failure="Could not delete the channel."
      run={() => onDetach(station, accountId)}
    />
  );
}
