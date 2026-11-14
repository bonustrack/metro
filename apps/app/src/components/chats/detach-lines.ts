import { supportedStation } from '@metro-labs/client/api/attach';

const DELETES = 'This deletes the channel and its saved login. Messages stop reaching the agent at once.';

const RECONNECT_NOTES: Record<string, string> = {
  webhook: 'This cannot be undone. Connecting again makes a new URL, so senders must be updated.',
  threema: 'This cannot be undone. Connecting again makes a new callback URL to paste into Threema Gateway.',
};

export function detachLines(station: string): string[] {
  if (!supportedStation(station)) return [DELETES, 'This cannot be undone. This kind of channel cannot be connected again.'];
  const reconnectNote = RECONNECT_NOTES[station] ?? 'This cannot be undone. To connect again, you sign in again.';
  return [DELETES, reconnectNote];
}
