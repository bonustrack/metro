import { emitInbound } from '@metro-labs/core/stations/train-events';
import { observeChannels } from './channels.js';
import {
  envelope,
  reactionCountEnvelope,
  reactionEnvelope,
  saveMediaAndEmit,
} from './format.js';
import type { TgUpdate } from './types.js';

export function handleUpdate(id: string, update: TgUpdate): void {
  observeChannels(id, update);
  if (update.message && !update.message.from?.is_bot) {
    const env = envelope(id, update.message);
    emitInbound(id, env);
    saveMediaAndEmit(id, update.message, env.id as string);
  }
  if (update.message_reaction) {
    const env = reactionEnvelope(id, update.message_reaction);
    if (env) emitInbound(id, env);
  }
  if (update.message_reaction_count) {
    const env = reactionCountEnvelope(id, update.message_reaction_count);
    if (env) emitInbound(id, env);
  }
}
