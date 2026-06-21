export interface TgMsg {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; first_name?: string };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    is_bot?: boolean;
  };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_name?: string; file_id?: string };
  voice?: { file_id?: string; duration?: number };
  audio?: { file_id?: string; file_name?: string };
  video?: { file_id?: string; file_name?: string };
  animation?: { file_id?: string; file_name?: string };
  sticker?: { file_id?: string; emoji?: string; set_name?: string };
  location?: { latitude: number; longitude: number };
  dice?: { emoji: string; value: number };
}

export interface TgReaction {
  chat: { id: number; type: string };
  message_id: number;
  user?: {
    id: number;
    username?: string;
    first_name?: string;
    is_bot?: boolean;
  };
  date: number;
  old_reaction: { type: string; emoji?: string }[];
  new_reaction: { type: string; emoji?: string }[];
}
