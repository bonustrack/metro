const RECONNECT_NOTES: Record<string, string> = {
  webhook: 'This cannot be undone. Connecting again makes a new URL, so senders must be updated.',
  threema: 'This cannot be undone. Connecting again makes a new callback URL to paste into Threema Gateway.',
};

export function detachLines(station: string, managed = false): string[] {
  if (station === 'gmail' && managed)
    return [
      'This revokes Google access and deletes the channel and its login. Mail stops reaching the agent.',
      'Google revokes all of Metro’s access to this account, so other boxes using it must sign in again too.',
      'If Google cannot revoke access, the connection is kept so you can retry.',
    ];
  const reconnectNote = RECONNECT_NOTES[station] ?? 'This cannot be undone. To connect again, you sign in again.';
  return ['This deletes the channel and its saved login. Messages stop reaching the agent at once.', reconnectNote];
}
