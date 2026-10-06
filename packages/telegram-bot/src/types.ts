export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  user?: { id: number };
}

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgMyChatMember {
  chat: TgChat;
  new_chat_member: { status: string; is_member?: boolean };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMsg;
  channel_post?: TgMsg;
  my_chat_member?: TgMyChatMember;
  message_reaction?: TgReaction;
  message_reaction_count?: TgReactionCount;
}

export interface TgMsg {
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: { message_id: number; from?: { id: number; username?: string; is_bot?: boolean } };
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_name?: string; file_id?: string; mime_type?: string };
  voice?: { file_id?: string; duration?: number; mime_type?: string };
  audio?: { file_id?: string; file_name?: string; mime_type?: string };
  video?: { file_id?: string; file_name?: string; mime_type?: string };
  animation?: { file_id?: string; file_name?: string; mime_type?: string };
  sticker?: { file_id?: string; emoji?: string; set_name?: string };
  location?: { latitude: number; longitude: number };
  dice?: { emoji: string; value: number };
}

export interface TgReaction {
  chat: TgChat;
  message_id: number;
  user?: TgUser;
  date: number;
  old_reaction: { type: string; emoji?: string }[];
  new_reaction: { type: string; emoji?: string }[];
}

export interface TgReactionCount {
  chat: TgChat;
  message_id: number;
  date: number;
  reactions: {
    type: { type: string; emoji?: string };
    total_count: number;
  }[];
}
