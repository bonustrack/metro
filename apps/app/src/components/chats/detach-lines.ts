const RECONNECT_NOTES: Record<string, string> = {
  webhook: 'This cannot be undone. Connecting again makes a new URL, so senders must be updated.',
  threema: 'This cannot be undone. Connecting again makes a new callback URL to paste into Threema Gateway.',
};

export function detachLines(station: string): string[] {
  const reconnectNote = RECONNECT_NOTES[station] ?? 'This cannot be undone. To connect again, you sign in again.';
  return ['This deletes the channel and its saved login. Messages stop reaching the agent at once.', reconnectNote];
}
