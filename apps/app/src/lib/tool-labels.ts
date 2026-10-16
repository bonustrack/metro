const LABELS: Record<string, string> = {
  send: 'Send messages',
  reply: 'Reply',
  react: 'React',
  unreact: 'Remove a reaction',
  typing: 'Typing',
  edit: 'Edit messages',
  delete: 'Delete messages',
  read: 'Read past messages',
  list_members: 'See who is in a chat',
  list_channels: 'List chats',
  create_group: 'Create groups',
  add_members: 'Add people to groups',
  remove_members: 'Remove people from groups',
  export_invite: 'Make invite links',
  set_profile: 'Change the profile',
  get_profile: 'Look people up',
  ask: 'Ask with a poll',
  dm: 'Start a private chat',
  group_info: 'Read group details',
  close_channel: 'Close a channel',
  set_channel_metadata: 'Change channel details',
};

export function toolLabel(name: string): string {
  const known = LABELS[name];
  if (known !== undefined) return known;
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words === '' ? name : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}
