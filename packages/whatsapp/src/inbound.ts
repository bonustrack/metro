import { emit } from './wire.js';
import { envelope, reactionEnvelope } from './format.js';
import type { WAClient } from './client.js';

export async function startInbound(client: WAClient): Promise<void> {
  await client.start({
    onMessage: (m) => {
      emit(envelope(m));
    },
    onReaction: (r) => {
      emit(reactionEnvelope(r));
    },
  });
}
